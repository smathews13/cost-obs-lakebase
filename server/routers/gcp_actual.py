"""
GCP Actual Costs Router — queries GCP billing export data via Lakehouse Federation.

Mirrors aws_actual.py / azure_actual.py but for GCP Cloud Billing export data
federated from BigQuery into Unity Catalog via a BigQuery connection.

Setup:
  1. In Unity Catalog, create a BigQuery connection:
       CREATE CONNECTION gcp_billing TYPE BIGQUERY
       OPTIONS (credentials '<service_account_key_json>');
  2. Create a foreign catalog pointing at the billing dataset:
       CREATE FOREIGN CATALOG gcp_billing_catalog
       USING CONNECTION gcp_billing
       OPTIONS (dataProjectId '<project_id>');
  3. Set env vars:
       GCP_COST_CATALOG=gcp_billing_catalog
       GCP_COST_SCHEMA=<bigquery_billing_dataset>   (e.g. all_billing_data)
       GCP_COST_TABLE=gcp_billing_export_v1         (or gcp_billing_export_resource_v1)

The router also supports a local `actuals_gold` Delta table (same schema as
aws_actual / azure_actual) if you prefer an ETL-curated table over live federation.
Set GCP_COST_TABLE=actuals_gold in that case.
"""

import asyncio
import logging
import os
import time
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Query

from server.db import execute_query

logger = logging.getLogger(__name__)
router = APIRouter()

_gcp_status_cache: dict[str, Any] = {"available": None, "checked_at": 0}
_GCP_STATUS_TTL = 300  # 5 minutes


def get_catalog_schema_table() -> tuple[str, str, str]:
    """Get catalog, schema, and table from environment or defaults.

    Defaults assume a Lakehouse Federation foreign catalog over the BigQuery
    billing export dataset. Override via env vars for a curated Delta table.
    """
    catalog = os.environ.get("GCP_COST_CATALOG", os.environ.get("COST_OBS_CATALOG", "billing"))
    schema = os.environ.get("GCP_COST_SCHEMA", "gcp")
    table = os.environ.get("GCP_COST_TABLE", "gcp_billing_export_v1")
    return catalog, schema, table


# ── SQL templates ─────────────────────────────────────────────────────────────
# These match the standard GCP Cloud Billing export schema (v1):
#   https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage
#
# Key columns:
#   usage_start_time / usage_end_time  TIMESTAMP
#   service.description                STRING  (e.g. "Compute Engine")
#   sku.description                    STRING  (e.g. "N1 Predefined Instance Core")
#   project.id                         STRING
#   cost                               FLOAT64 (in billing currency)
#   currency                           STRING
#   labels                             ARRAY<STRUCT<key STRING, value STRING>>
#   resource.name                      STRING  (instance/cluster identifier)
#   resource.global_name               STRING
# ─────────────────────────────────────────────────────────────────────────────

CHECK_GCP_TABLE = """
SELECT 1
FROM information_schema.tables
WHERE table_catalog = '{catalog}'
  AND table_schema  = '{schema}'
  AND table_name    = '{table}'
LIMIT 1
"""

GCP_ACTUAL_SUMMARY = """
SELECT
  SUM(cost)                              AS total_cost,
  currency                               AS currency,
  COUNT(DISTINCT project.id)             AS project_count,
  COUNT(DISTINCT service.description)    AS service_count,
  COUNT(DISTINCT DATE(usage_start_time)) AS days_in_range
FROM {catalog}.{schema}.{table}
WHERE DATE(usage_start_time) >= :start_date
  AND DATE(usage_start_time) <  :end_date
  AND cost > 0
GROUP BY currency
ORDER BY total_cost DESC
LIMIT 1
"""

GCP_COSTS_BY_SERVICE = """
SELECT
  service.description                     AS service,
  SUM(cost)                               AS total_cost,
  COUNT(DISTINCT DATE(usage_start_time))  AS days_active
FROM {catalog}.{schema}.{table}
WHERE DATE(usage_start_time) >= :start_date
  AND DATE(usage_start_time) <  :end_date
  AND cost > 0
GROUP BY service.description
ORDER BY total_cost DESC
LIMIT 50
"""

GCP_COSTS_BY_PROJECT = """
SELECT
  project.id                              AS project_id,
  project.name                            AS project_name,
  SUM(cost)                               AS total_cost,
  COUNT(DISTINCT service.description)     AS service_count
FROM {catalog}.{schema}.{table}
WHERE DATE(usage_start_time) >= :start_date
  AND DATE(usage_start_time) <  :end_date
  AND cost > 0
GROUP BY project.id, project.name
ORDER BY total_cost DESC
LIMIT 50
"""

GCP_COSTS_BY_SKU = """
SELECT
  service.description  AS service,
  sku.description      AS sku,
  SUM(cost)            AS total_cost
FROM {catalog}.{schema}.{table}
WHERE DATE(usage_start_time) >= :start_date
  AND DATE(usage_start_time) <  :end_date
  AND cost > 0
GROUP BY service.description, sku.description
ORDER BY total_cost DESC
LIMIT 100
"""

GCP_COSTS_TIMESERIES = """
SELECT
  DATE(usage_start_time) AS date,
  service.description    AS service,
  SUM(cost)              AS daily_cost
FROM {catalog}.{schema}.{table}
WHERE DATE(usage_start_time) >= :start_date
  AND DATE(usage_start_time) <  :end_date
  AND cost > 0
GROUP BY DATE(usage_start_time), service.description
ORDER BY date
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _defaults(start_date, end_date):
    if not end_date:
        end_date = date.today().isoformat()
    if not start_date:
        start_date = (date.today() - timedelta(days=30)).isoformat()
    return start_date, end_date


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_gcp_status() -> dict[str, Any]:
    """Check if GCP billing tables are available (cached 5 min)."""
    catalog, schema, table = get_catalog_schema_table()

    if (
        _gcp_status_cache["available"] is not None
        and (time.time() - _gcp_status_cache["checked_at"]) < _GCP_STATUS_TTL
    ):
        available = _gcp_status_cache["available"]
    else:
        try:
            results = execute_query(
                CHECK_GCP_TABLE.format(catalog=catalog, schema=schema, table=table)
            )
            available = len(results) > 0
        except Exception as e:
            logger.warning(f"GCP billing tables not available: {e}")
            available = False
        _gcp_status_cache["available"] = available
        _gcp_status_cache["checked_at"] = time.time()

    return {
        "gcp_available": available,
        "catalog": catalog,
        "schema": schema,
        "table": table if available else None,
    }


@router.get("/summary")
async def get_gcp_actual_summary(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get summary of actual GCP costs."""
    catalog, schema, table = get_catalog_schema_table()
    start_date, end_date = _defaults(start_date, end_date)

    status = await get_gcp_status()
    if not status["gcp_available"]:
        return {
            "available": False,
            "message": "GCP billing data not configured. Connect a BigQuery billing export via Lakehouse Federation.",
            "start_date": start_date,
            "end_date": end_date,
        }

    results = execute_query(
        GCP_ACTUAL_SUMMARY.format(catalog=catalog, schema=schema, table=table),
        {"start_date": start_date, "end_date": end_date},
    )

    if not results:
        return {
            "available": True,
            "total_cost": 0,
            "currency": "USD",
            "project_count": 0,
            "service_count": 0,
            "days_in_range": 0,
            "start_date": start_date,
            "end_date": end_date,
        }

    row = results[0]
    return {
        "available": True,
        "total_cost": float(row.get("total_cost") or 0),
        "currency": row.get("currency") or "USD",
        "project_count": row.get("project_count") or 0,
        "service_count": row.get("service_count") or 0,
        "days_in_range": row.get("days_in_range") or 0,
        "start_date": start_date,
        "end_date": end_date,
    }


@router.get("/by-service")
async def get_gcp_costs_by_service(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get actual GCP costs broken down by GCP service (Compute Engine, GCS, BigQuery, etc.)."""
    catalog, schema, table = get_catalog_schema_table()
    start_date, end_date = _defaults(start_date, end_date)

    status = await get_gcp_status()
    if not status["gcp_available"]:
        return {"available": False, "services": [], "start_date": start_date, "end_date": end_date}

    results = execute_query(
        GCP_COSTS_BY_SERVICE.format(catalog=catalog, schema=schema, table=table),
        {"start_date": start_date, "end_date": end_date},
    )

    total_cost = sum(float(r.get("total_cost") or 0) for r in results)
    services = [
        {
            "service": r.get("service") or "Other",
            "total_cost": float(r.get("total_cost") or 0),
            "days_active": r.get("days_active") or 0,
            "percentage": float(r.get("total_cost") or 0) / total_cost * 100 if total_cost > 0 else 0,
        }
        for r in results
    ]

    return {
        "available": True,
        "services": services,
        "total_cost": total_cost,
        "start_date": start_date,
        "end_date": end_date,
    }


@router.get("/by-project")
async def get_gcp_costs_by_project(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get actual GCP costs broken down by GCP project."""
    catalog, schema, table = get_catalog_schema_table()
    start_date, end_date = _defaults(start_date, end_date)

    status = await get_gcp_status()
    if not status["gcp_available"]:
        return {"available": False, "projects": [], "start_date": start_date, "end_date": end_date}

    results = execute_query(
        GCP_COSTS_BY_PROJECT.format(catalog=catalog, schema=schema, table=table),
        {"start_date": start_date, "end_date": end_date},
    )

    total_cost = sum(float(r.get("total_cost") or 0) for r in results)
    projects = [
        {
            "project_id": r.get("project_id") or "unknown",
            "project_name": r.get("project_name") or r.get("project_id") or "unknown",
            "total_cost": float(r.get("total_cost") or 0),
            "service_count": r.get("service_count") or 0,
            "percentage": float(r.get("total_cost") or 0) / total_cost * 100 if total_cost > 0 else 0,
        }
        for r in results
    ]

    return {
        "available": True,
        "projects": projects,
        "total_cost": total_cost,
        "start_date": start_date,
        "end_date": end_date,
    }


@router.get("/by-sku")
async def get_gcp_costs_by_sku(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get actual GCP costs broken down by SKU."""
    catalog, schema, table = get_catalog_schema_table()
    start_date, end_date = _defaults(start_date, end_date)

    status = await get_gcp_status()
    if not status["gcp_available"]:
        return {"available": False, "skus": [], "start_date": start_date, "end_date": end_date}

    results = execute_query(
        GCP_COSTS_BY_SKU.format(catalog=catalog, schema=schema, table=table),
        {"start_date": start_date, "end_date": end_date},
    )

    total_cost = sum(float(r.get("total_cost") or 0) for r in results)
    skus = [
        {
            "service": r.get("service") or "Other",
            "sku": r.get("sku") or "Other",
            "total_cost": float(r.get("total_cost") or 0),
            "percentage": float(r.get("total_cost") or 0) / total_cost * 100 if total_cost > 0 else 0,
        }
        for r in results
    ]

    return {
        "available": True,
        "skus": skus,
        "total_cost": total_cost,
        "start_date": start_date,
        "end_date": end_date,
    }


@router.get("/timeseries")
async def get_gcp_costs_timeseries(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get daily GCP costs timeseries by service."""
    catalog, schema, table = get_catalog_schema_table()
    start_date, end_date = _defaults(start_date, end_date)

    status = await get_gcp_status()
    if not status["gcp_available"]:
        return {"available": False, "timeseries": [], "services": [], "start_date": start_date, "end_date": end_date}

    results = execute_query(
        GCP_COSTS_TIMESERIES.format(catalog=catalog, schema=schema, table=table),
        {"start_date": start_date, "end_date": end_date},
    )

    data_by_date: dict[str, dict] = {}
    services_set: set[str] = set()

    for row in results:
        date_str = str(row.get("date"))
        svc = row.get("service") or "Other"
        cost = float(row.get("daily_cost") or 0)
        services_set.add(svc)
        if date_str not in data_by_date:
            data_by_date[date_str] = {"date": date_str}
        data_by_date[date_str][svc] = cost

    services = sorted(list(services_set))
    timeseries = []
    for date_str in sorted(data_by_date.keys()):
        row = data_by_date[date_str]
        for svc in services:
            row.setdefault(svc, 0)
        timeseries.append(row)

    return {
        "available": True,
        "timeseries": timeseries,
        "services": services,
        "start_date": start_date,
        "end_date": end_date,
    }


@router.get("/dashboard-bundle")
async def get_gcp_actual_dashboard_bundle(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get all GCP actual cost data in a single parallel request."""
    start_date, end_date = _defaults(start_date, end_date)

    status = await get_gcp_status()
    if not status["gcp_available"]:
        return {
            "available": False,
            "message": "GCP billing data not configured. Set up Lakehouse Federation to BigQuery billing export.",
            "start_date": start_date,
            "end_date": end_date,
        }

    summary, by_service, by_project, by_sku, timeseries = await asyncio.gather(
        get_gcp_actual_summary(start_date, end_date),
        get_gcp_costs_by_service(start_date, end_date),
        get_gcp_costs_by_project(start_date, end_date),
        get_gcp_costs_by_sku(start_date, end_date),
        get_gcp_costs_timeseries(start_date, end_date),
    )

    return {
        "available": True,
        "summary": summary,
        "by_service": by_service,
        "by_project": by_project,
        "by_sku": by_sku,
        "timeseries": timeseries,
        "start_date": start_date,
        "end_date": end_date,
    }
