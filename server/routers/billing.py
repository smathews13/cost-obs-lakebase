"""Billing API endpoints for cost observability."""

import logging
import os
import time
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Query

from server.db import execute_query, execute_queries_parallel, get_catalog_schema, get_host_url, get_workspace_client
from server.queries import (
    ACCOUNT_INFO,
    AWS_COST_BY_INSTANCE_TYPE,
    AWS_COST_ESTIMATE,
    AWS_COST_TIMESERIES,
    BILLING_BY_PRODUCT,
    BILLING_BY_PRODUCT_FAST,
    BILLING_BY_PRODUCT_WORKSPACE,
    BILLING_BY_WORKSPACE,
    BILLING_SUMMARY,
    BILLING_TIMESERIES,
    BILLING_TIMESERIES_FAST,
    ETL_BREAKDOWN,
    INFRA_COST_ESTIMATE,
    INFRA_COST_TIMESERIES,
    INTERACTIVE_BREAKDOWN,
    PIPELINE_OBJECTS,
    PLATFORM_KPIS,
    PLATFORM_KPIS_FAST,
    SKU_BREAKDOWN,
    SPEND_ANOMALIES,
    SQL_TOOL_ATTRIBUTION,
)
from server.cloud_pricing import (
    get_instance_family,
    get_instance_pricing,
    get_pricing_disclaimer,
    get_cloud_display_name,
)
from server.materialized_views import (
    MV_BILLING_BY_PRODUCT,
    MV_BILLING_BY_WORKSPACE,
    MV_BILLING_SUMMARY,
    MV_BILLING_TIMESERIES,
    MV_ETL_BREAKDOWN,
    MV_PLATFORM_KPIS,
    MV_SQL_TOOL_ATTRIBUTION,
    check_materialized_views_exist,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def _ensure_list(val: Any) -> list:
    """Convert COLLECT_LIST results to a proper Python list.

    Databricks COLLECT_LIST may return Java arrays or stringified arrays
    that don't serialize to JSON properly.
    """
    if val is None:
        return []
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        import json
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
        # Try comma-separated string
        stripped = val.strip("[]")
        if stripped:
            return [s.strip().strip("'\"") for s in stripped.split(",")]
        return []
    # Try converting iterable types (Java arrays, etc.)
    try:
        return list(val)
    except (TypeError, ValueError):
        return []

# Cache for MV availability check (check every 5 minutes)
_mv_cache: dict[str, Any] = {"available": None, "checked_at": 0}
_MV_CHECK_INTERVAL = 300  # 5 minutes


def _check_mv_available() -> bool:
    """Check if materialized views are available (with caching)."""
    now = time.time()
    if _mv_cache["available"] is not None and (now - _mv_cache["checked_at"]) < _MV_CHECK_INTERVAL:
        return _mv_cache["available"]

    try:
        catalog, schema = get_catalog_schema()
        tables = check_materialized_views_exist(catalog, schema)
        core_tables = ["daily_usage_summary", "daily_product_breakdown", "daily_workspace_breakdown"]
        available = all(tables.get(t, False) for t in core_tables)
        _mv_cache["available"] = available
        _mv_cache["checked_at"] = now
        if available:
            logger.info("Materialized views available - using optimized queries")
        return available
    except Exception as e:
        logger.debug(f"MV check failed: {e}")
        _mv_cache["available"] = False
        _mv_cache["checked_at"] = now
        return False


def _get_mv_query(mv_query: str) -> str:
    """Format a materialized view query with the correct catalog/schema."""
    catalog, schema = get_catalog_schema()
    return mv_query.format(catalog=catalog, schema=schema)


def _exec_mv(mv_template: str, params: dict) -> list[dict]:
    """Execute a materialized view query against Delta."""
    catalog, schema = get_catalog_schema()
    return execute_query(mv_template.format(catalog=catalog, schema=schema), params)


def get_workspace_name() -> str | None:
    """Get workspace name from Databricks SDK."""
    try:
        w = get_workspace_client()
        host = w.config.host or ""
        if host:
            # Extract workspace name from host
            # e.g., https://e2-demo-field-eng.cloud.databricks.com
            parts = host.replace("https://", "").replace("http://", "").split(".")
            if parts:
                return parts[0]
        return None
    except Exception:
        return None


@router.get("/account")
async def get_account_info() -> dict[str, Any]:
    """Get account information — returns instantly from host URL, no SQL query needed."""
    result: dict[str, Any] = {
        "account_id": None,
        "account_name": None,
        "cloud": None,
        "host": None,
    }

    # Instant: detect everything from host URL
    host = get_host_url()
    if host:
        result["host"] = host
        parts = host.replace("https://", "").replace("http://", "").split(".")
        if parts:
            result["account_name"] = parts[0]
        host_lower = host.lower()
        if "azuredatabricks.net" in host_lower:
            result["cloud"] = "AZURE"
            # Use Azure subscription ID (not available from host URL, set via env)
            result["account_id"] = os.environ.get("AZURE_SUBSCRIPTION_ID", None)
        elif "gcp.databricks.com" in host_lower:
            result["cloud"] = "GCP"
        elif "cloud.databricks.com" in host_lower:
            result["cloud"] = "AWS"

    return result


@router.get("/account-details")
async def get_account_details() -> dict[str, Any]:
    """Get account_id from billing data — may be slow, called separately."""
    try:
        import asyncio
        results = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, lambda: execute_query(ACCOUNT_INFO)),
            timeout=10.0
        )
        if results:
            row = results[0]
            return {
                "account_id": row.get("account_id"),
                "cloud": row.get("cloud"),
            }
    except Exception as e:
        logger.warning(f"Could not query account details from billing tables: {e}")
    return {"account_id": None, "cloud": None}


def get_default_start_date() -> str:
    """Get default start date (last 30 days)."""
    return (date.today() - timedelta(days=30)).isoformat()


def get_default_end_date() -> str:
    """Get default end date (today)."""
    return date.today().isoformat()


@router.get("/summary")
async def get_billing_summary(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get overall billing summary (total spend, DBUs, etc.)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    if _check_mv_available():
        results = _exec_mv(MV_BILLING_SUMMARY, params)
        if not results:
            results = execute_query(BILLING_SUMMARY, params)
    else:
        results = execute_query(BILLING_SUMMARY, params)

    if not results:
        return {
            "total_dbus": 0,
            "total_spend": 0,
            "workspace_count": 0,
            "days_in_range": 0,
            "avg_daily_spend": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    row = results[0]
    days = row.get("days_in_range") or 1
    total_spend = float(row.get("total_spend") or 0)

    return {
        "total_dbus": float(row.get("total_dbus") or 0),
        "total_spend": total_spend,
        "workspace_count": row.get("workspace_count") or 0,
        "days_in_range": days,
        "avg_daily_spend": total_spend / days if days > 0 else 0,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
        "first_date": str(row.get("first_date")) if row.get("first_date") else None,
        "last_date": str(row.get("last_date")) if row.get("last_date") else None,
    }


@router.get("/by-product")
async def get_billing_by_product(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_id: str = Query(default=None, description="Filter by workspace ID"),
) -> dict[str, Any]:
    """Get billing breakdown by product category."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    if workspace_id:
        # Add workspace filter to the query
        params["workspace_id"] = workspace_id
        results = execute_query(BILLING_BY_PRODUCT_WORKSPACE, params)
    else:
        results = execute_query(BILLING_BY_PRODUCT, params)

    products = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        products.append(
            {
                "category": row.get("product_category"),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "workspace_count": row.get("workspace_count") or 0,
            }
        )

    # Calculate percentages
    for product in products:
        product["percentage"] = (
            (product["total_spend"] / total_spend * 100) if total_spend > 0 else 0
        )

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/by-workspace")
async def get_billing_by_workspace(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get billing breakdown by workspace."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Always use the live query here — the MV lacks top_products and top_users columns.
    results = execute_query(BILLING_BY_WORKSPACE, params)
    return _format_workspaces(results, params)


@router.get("/timeseries")
async def get_billing_timeseries(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get daily billing time series by product category."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(BILLING_TIMESERIES, params)

    # Transform to chart-friendly format: [{date, SQL, ETL, Interactive, ...}, ...]
    date_data: dict[str, dict[str, float]] = {}

    for row in results:
        date_str = str(row.get("usage_date"))
        category = row.get("product_category")
        spend = float(row.get("total_spend") or 0)

        if date_str not in date_data:
            date_data[date_str] = {"date": date_str}

        date_data[date_str][category] = spend

    # Convert to list sorted by date
    timeseries = sorted(date_data.values(), key=lambda x: x["date"])

    # Get all categories
    categories = set()
    for row in results:
        categories.add(row.get("product_category"))

    return {
        "timeseries": timeseries,
        "categories": sorted(list(categories)),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/sql-breakdown")
async def get_sql_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get SQL breakdown by tool (DBSQL vs Genie).

    Uses materialized views when available for fast queries.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    try:
        use_mv = _check_mv_available()
        if use_mv:
            results = _exec_mv(MV_SQL_TOOL_ATTRIBUTION, params)
        else:
            results = execute_query(SQL_TOOL_ATTRIBUTION, params)

        products = []
        total_spend = 0

        for row in results:
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            products.append(
                {
                    "product": row.get("sql_product"),
                    "total_dbus": float(row.get("total_dbus") or 0),
                    "total_spend": spend,
                }
            )

        # Calculate percentages
        for product in products:
            product["percentage"] = (
                (product["total_spend"] / total_spend * 100) if total_spend > 0 else 0
            )

        return {
            "products": products,
            "total_spend": total_spend,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "using_materialized_views": use_mv,
        }
    except Exception as e:
        # If query.history is not available, return empty result
        return {
            "products": [],
            "total_spend": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"SQL breakdown not available: {str(e)}",
        }


@router.get("/etl-breakdown")
async def get_etl_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get ETL breakdown (Batch vs Streaming)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(ETL_BREAKDOWN, params)

    products = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        products.append(
            {
                "product": row.get("etl_type"),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
            }
        )

    # Calculate percentages
    for product in products:
        product["percentage"] = (
            (product["total_spend"] / total_spend * 100) if total_spend > 0 else 0
        )

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/pipeline-objects")
async def get_pipeline_objects(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get spend breakdown by pipeline objects (Jobs and SDP pipelines)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    try:
        results = _enrich_pipeline_results(execute_query(PIPELINE_OBJECTS, params))

        objects = []
        total_spend = 0

        for row in (results or []):
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            obj_name = row.get("object_name")
            obj_id = row.get("object_id")
            objects.append(
                {
                    "object_type": row.get("object_type"),
                    "object_id": obj_id,
                    "object_name": obj_name,
                    "workspace_id": str(row.get("workspace_id") or ""),
                    "object_state": row.get("object_state"),
                    "owner": row.get("owner"),
                    "total_dbus": float(row.get("total_dbus") or 0),
                    "total_spend": spend,
                    "total_runs": int(row.get("total_runs") or 0),
                }
            )

        # Calculate percentages
        for obj in objects:
            obj["percentage"] = (
                (obj["total_spend"] / total_spend * 100) if total_spend > 0 else 0
            )

        return {
            "objects": objects,
            "total_spend": total_spend,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
    except Exception as e:
        return {
            "objects": [],
            "total_spend": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"Pipeline objects not available: {str(e)}",
        }


@router.get("/interactive-breakdown")
async def get_interactive_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get Interactive compute breakdown by notebook, user, and cluster."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    try:
        results = execute_query(INTERACTIVE_BREAKDOWN, params)

        items = []
        total_spend = 0

        for row in results:
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            items.append(
                {
                    "cluster_id": row.get("cluster_id"),
                    "cluster_name": row.get("cluster_name"),
                    "notebook_path": row.get("notebook_path"),
                    "user": row.get("run_as_user"),
                    "workspace_id": row.get("workspace_id"),
                    "cluster_state": row.get("cluster_state"),
                    "total_dbus": float(row.get("total_dbus") or 0),
                    "total_spend": spend,
                    "days_active": row.get("days_active") or 0,
                    "notebook_count": row.get("notebook_count") or 0,
                }
            )

        # Calculate percentages
        for item in items:
            item["percentage"] = (
                (item["total_spend"] / total_spend * 100) if total_spend > 0 else 0
            )

        return {
            "items": items,
            "total_spend": total_spend,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
    except Exception as e:
        return {
            "items": [],
            "total_spend": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"Interactive breakdown not available: {str(e)}",
        }


@router.get("/infra-costs")
async def get_infra_costs(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get estimated infrastructure costs based on cluster instance types.

    Automatically detects the cloud provider (AWS or Azure) and uses appropriate pricing.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    try:
        # Single query — instance families are derived in Python from cluster results
        cluster_results = execute_query(INFRA_COST_ESTIMATE, params)

        # Detect cloud from results, fall back to host URL detection
        host = get_host_url()
        cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h:
                cloud = "AZURE"
            elif "gcp.databricks.com" in h:
                cloud = "GCP"
        if cluster_results:
            for row in cluster_results:
                if row.get("cloud"):
                    cloud = row.get("cloud")
                    break

        clusters = []
        total_estimated_cost = 0
        total_dbu_hours = 0
        family_agg: dict[str, dict] = {}

        for row in cluster_results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            driver_type = row.get("driver_instance_type")
            worker_type = row.get("worker_instance_type")

            driver_cost = get_instance_pricing(driver_type, cloud)
            worker_cost = get_instance_pricing(worker_type, cloud)
            estimated_cost = dbu_hours * (driver_cost + worker_cost * 2) / 2

            total_estimated_cost += estimated_cost
            total_dbu_hours += dbu_hours

            clusters.append({
                "cluster_id": row.get("cluster_id"),
                "cluster_name": row.get("cluster_name"),
                "driver_instance_type": driver_type,
                "worker_instance_type": worker_type,
                "cluster_source": row.get("cluster_source"),
                "total_dbu_hours": dbu_hours,
                "estimated_cost": estimated_cost,
                "days_active": row.get("days_active") or 0,
            })

            # Aggregate instance families from cluster data — no second query needed
            for itype in [driver_type, worker_type]:
                if itype:
                    family = get_instance_family(itype, cloud)
                    days = row.get("days_active") or 0
                    if family in family_agg:
                        family_agg[family]["total_dbu_hours"] += dbu_hours
                        family_agg[family]["days_active"] = max(family_agg[family]["days_active"], days)
                    else:
                        family_agg[family] = {"instance_family": family, "total_dbu_hours": dbu_hours, "days_active": days}

        for cluster in clusters:
            cluster["percentage"] = (
                (cluster["estimated_cost"] / total_estimated_cost * 100)
                if total_estimated_cost > 0 else 0
            )
        instance_families = sorted(family_agg.values(), key=lambda f: f["total_dbu_hours"], reverse=True)

        return {
            "cloud": cloud,
            "cloud_display_name": get_cloud_display_name(cloud),
            "clusters": clusters,
            "instance_families": instance_families,
            "total_estimated_cost": total_estimated_cost,
            "total_dbu_hours": total_dbu_hours,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "disclaimer": get_pricing_disclaimer(cloud),
        }
    except Exception as e:
        return {
            "cloud": "UNKNOWN",
            "cloud_display_name": "Cloud",
            "clusters": [],
            "instance_families": [],
            "total_estimated_cost": 0,
            "total_dbu_hours": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"Infrastructure cost estimation not available: {str(e)}",
        }


@router.get("/infra-costs-timeseries")
async def get_infra_costs_timeseries(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get estimated infrastructure costs over time (daily).

    Automatically detects cloud provider and uses appropriate pricing.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    try:
        results = execute_query(INFRA_COST_TIMESERIES, params)

        # Detect cloud from host URL, override with billing data if available
        host = get_host_url()
        cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h:
                cloud = "AZURE"
            elif "gcp.databricks.com" in h:
                cloud = "GCP"
        if results:
            for row in results:
                if row.get("cloud"):
                    cloud = row.get("cloud")
                    break

        timeseries = []
        for row in results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            # Use average pricing for timeseries (rough estimate)
            avg_cost_per_hour = 0.50  # Reasonable average
            estimated_cost = dbu_hours * avg_cost_per_hour

            timeseries.append(
                {
                    "date": str(row.get("usage_date")),
                    "Infrastructure Cost": estimated_cost,
                    "total_dbu_hours": dbu_hours,
                }
            )

        return {
            "cloud": cloud,
            "cloud_display_name": get_cloud_display_name(cloud),
            "timeseries": timeseries,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
    except Exception as e:
        return {
            "cloud": "UNKNOWN",
            "cloud_display_name": "Cloud",
            "timeseries": [],
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"Infrastructure cost timeseries not available: {str(e)}",
        }


@router.get("/infra-bundle")
async def get_infra_bundle(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Bundled infra endpoint: runs cluster costs, instance families, and timeseries in parallel."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Billing-based summary query — matches KPI trend drill-downs exactly
    BILLING_INFRA_SUMMARY = """
    WITH usage_with_price AS (
      SELECT
        u.usage_date,
        u.usage_quantity,
        u.usage_metadata.cluster_id as cluster_id,
        COALESCE(p.pricing.default, 0) as price_per_dbu
      FROM system.billing.usage u
      LEFT JOIN system.billing.list_prices p
        ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
      WHERE u.usage_date BETWEEN :start_date AND :end_date
        AND u.usage_quantity > 0
        AND u.usage_metadata.cluster_id IS NOT NULL
        AND (u.sku_name LIKE '%ALL_PURPOSE%' OR u.sku_name LIKE '%JOBS%' OR u.sku_name LIKE '%DLT%')
    ),
    daily_stats AS (
      SELECT
        usage_date,
        SUM(usage_quantity * price_per_dbu) as daily_cost,
        COUNT(DISTINCT cluster_id) as daily_clusters
      FROM usage_with_price
      GROUP BY usage_date
    )
    SELECT
      SUM(daily_cost) as total_cost,
      AVG(daily_clusters) as avg_clusters_per_day,
      CASE WHEN AVG(daily_clusters) > 0 THEN AVG(daily_cost / daily_clusters) ELSE 0 END as avg_cost_per_cluster,
      COUNT(*) as days_in_range
    FROM daily_stats
    """

    try:
        query_results = execute_queries_parallel([
            ("clusters", lambda: execute_query(INFRA_COST_ESTIMATE, params)),
            ("timeseries", lambda: execute_query(INFRA_COST_TIMESERIES, params)),
            ("billing_summary", lambda: execute_query(BILLING_INFRA_SUMMARY, params)),
        ])

        cluster_results = query_results.get("clusters") or []
        ts_results = query_results.get("timeseries") or []
        billing_summary_results = query_results.get("billing_summary") or []

        # Detect cloud from host URL, override with billing data if available
        host = get_host_url()
        cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h:
                cloud = "AZURE"
            elif "gcp.databricks.com" in h:
                cloud = "GCP"
        if cluster_results:
            for row in cluster_results:
                if row.get("cloud"):
                    cloud = row.get("cloud")
                    break

        # --- Build clusters and instance families in one pass ---
        clusters = []
        total_estimated_cost = 0
        total_dbu_hours = 0
        family_agg: dict[str, dict] = {}

        for row in cluster_results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            driver_type = row.get("driver_instance_type")
            worker_type = row.get("worker_instance_type")
            driver_cost = get_instance_pricing(driver_type, cloud)
            worker_cost = get_instance_pricing(worker_type, cloud)
            estimated_cost = dbu_hours * (driver_cost + worker_cost * 2) / 2
            total_estimated_cost += estimated_cost
            total_dbu_hours += dbu_hours
            clusters.append({
                "cluster_id": row.get("cluster_id"),
                "cluster_name": row.get("cluster_name"),
                "driver_instance_type": driver_type,
                "worker_instance_type": worker_type,
                "cluster_source": row.get("cluster_source"),
                "workspace_id": str(row.get("workspace_id") or ""),
                "total_dbu_hours": dbu_hours,
                "estimated_cost": estimated_cost,
                "days_active": row.get("days_active") or 0,
            })
            # Derive instance families from cluster data — no second query needed
            for itype in [driver_type, worker_type]:
                if itype:
                    family = get_instance_family(itype, cloud)
                    days = row.get("days_active") or 0
                    if family in family_agg:
                        family_agg[family]["total_dbu_hours"] += dbu_hours
                        family_agg[family]["days_active"] = max(family_agg[family]["days_active"], days)
                    else:
                        family_agg[family] = {"instance_family": family, "total_dbu_hours": dbu_hours, "days_active": days}

        for cluster in clusters:
            cluster["percentage"] = (
                (cluster["estimated_cost"] / total_estimated_cost * 100)
                if total_estimated_cost > 0 else 0
            )
        instance_families = sorted(family_agg.values(), key=lambda f: f["total_dbu_hours"], reverse=True)

        # --- Build timeseries ---
        timeseries = []
        for row in ts_results:
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            avg_cost_per_hour = 0.50
            estimated_cost = dbu_hours * avg_cost_per_hour
            timeseries.append({
                "date": str(row.get("usage_date")),
                "Infrastructure Cost": estimated_cost,
                "total_dbu_hours": dbu_hours,
            })

        # Extract billing-based summary (matches KPI drill-downs)
        billing_summary = {}
        if billing_summary_results:
            bs = billing_summary_results[0]
            billing_summary = {
                "total_cost": float(bs.get("total_cost") or 0),
                "avg_clusters_per_day": round(float(bs.get("avg_clusters_per_day") or 0)),
                "avg_cost_per_cluster": float(bs.get("avg_cost_per_cluster") or 0),
                "days_in_range": int(bs.get("days_in_range") or 0),
            }

        return {
            "infra_costs": {
                "cloud": cloud,
                "cloud_display_name": get_cloud_display_name(cloud),
                "clusters": clusters,
                "instance_families": instance_families,
                "total_estimated_cost": total_estimated_cost,
                "total_dbu_hours": total_dbu_hours,
                "billing_summary": billing_summary,
                "start_date": params["start_date"],
                "end_date": params["end_date"],
                "disclaimer": get_pricing_disclaimer(cloud),
            },
            "infra_timeseries": {
                "cloud": cloud,
                "cloud_display_name": get_cloud_display_name(cloud),
                "timeseries": timeseries,
                "start_date": params["start_date"],
                "end_date": params["end_date"],
            },
        }
    except Exception as e:
        logger.error(f"Infra bundle error: {e}")
        host = get_host_url()
        err_cloud = "AWS"
        if host:
            h = host.lower()
            if "azuredatabricks.net" in h: err_cloud = "AZURE"
            elif "gcp.databricks.com" in h: err_cloud = "GCP"
        empty = {
            "cloud": err_cloud, "cloud_display_name": get_cloud_display_name(err_cloud),
            "start_date": params["start_date"], "end_date": params["end_date"],
        }
        return {
            "infra_costs": {**empty, "clusters": [], "instance_families": [], "total_estimated_cost": 0, "total_dbu_hours": 0, "error": str(e)},
            "infra_timeseries": {**empty, "timeseries": [], "error": str(e)},
        }


@router.get("/aws-costs")
async def get_aws_costs(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get estimated AWS infrastructure costs based on cluster instance types.

    DEPRECATED: Use /infra-costs instead for multi-cloud support.
    This endpoint is maintained for backwards compatibility.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    try:
        # Get detailed cluster costs
        cluster_results = execute_query(AWS_COST_ESTIMATE, params)

        clusters = []
        total_estimated_cost = 0
        total_dbu_hours = 0

        for row in cluster_results:
            cost = float(row.get("estimated_aws_cost") or 0)
            dbu_hours = float(row.get("total_dbu_hours") or 0)
            total_estimated_cost += cost
            total_dbu_hours += dbu_hours
            clusters.append(
                {
                    "cluster_id": row.get("cluster_id"),
                    "cluster_name": row.get("cluster_name"),
                    "driver_instance_type": row.get("driver_instance_type"),
                    "worker_instance_type": row.get("worker_instance_type"),
                    "cluster_source": row.get("cluster_source"),
                    "total_dbu_hours": dbu_hours,
                    "estimated_aws_cost": cost,
                    "days_active": row.get("days_active") or 0,
                }
            )

        # Calculate percentages
        for cluster in clusters:
            cluster["percentage"] = (
                (cluster["estimated_aws_cost"] / total_estimated_cost * 100)
                if total_estimated_cost > 0
                else 0
            )

        # Get instance family breakdown
        family_results = execute_query(AWS_COST_BY_INSTANCE_TYPE, params)
        instance_families = []
        for row in family_results:
            instance_families.append(
                {
                    "instance_family": row.get("instance_family"),
                    "total_dbu_hours": float(row.get("total_dbu_hours") or 0),
                    "days_active": row.get("days_active") or 0,
                }
            )

        return {
            "clusters": clusters,
            "instance_families": instance_families,
            "total_estimated_cost": total_estimated_cost,
            "total_dbu_hours": total_dbu_hours,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "disclaimer": "AWS costs are estimated based on EC2 On-Demand pricing (US East). Actual costs may vary based on region, reserved instances, and spot pricing.",
        }
    except Exception as e:
        return {
            "clusters": [],
            "instance_families": [],
            "total_estimated_cost": 0,
            "total_dbu_hours": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"AWS cost estimation not available: {str(e)}",
        }


@router.get("/aws-costs-timeseries")
async def get_aws_costs_timeseries(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get estimated AWS infrastructure costs over time (daily rolling aggregate)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    try:
        results = execute_query(AWS_COST_TIMESERIES, params)
        return _format_aws_timeseries(results, params)
    except Exception as e:
        return {
            "timeseries": [],
            "instance_families": [],
            "start_date": params["start_date"],
            "end_date": params["end_date"],
            "error": f"AWS cost timeseries not available: {str(e)}",
        }

_pipeline_names_cache: dict[str, str] | None = None
_pipeline_names_cache_ts: float = 0
_PIPELINE_CACHE_TTL = 3600  # 1 hour


def _get_pipeline_names() -> dict[str, str]:
    """Get pipeline ID → name mapping. Try system table first, fall back to SDK. Cached for 1 hour."""
    global _pipeline_names_cache, _pipeline_names_cache_ts
    import time as _time
    now = _time.monotonic()
    if _pipeline_names_cache is not None and (now - _pipeline_names_cache_ts) < _PIPELINE_CACHE_TTL:
        return _pipeline_names_cache

    # Try system.lakeflow.pipelines (cross-workspace)
    try:
        results = execute_query("""
            SELECT pipeline_id, MAX(name) as pipeline_name
            FROM system.lakeflow.pipelines
            WHERE delete_time IS NULL AND name IS NOT NULL
            GROUP BY pipeline_id
        """)
        if results:
            names = {r["pipeline_id"]: r["pipeline_name"] for r in results if r.get("pipeline_id") and r.get("pipeline_name")}
            logger.info(f"Pipeline names from system table: {len(names)} found")
            if names:
                _pipeline_names_cache = names
                _pipeline_names_cache_ts = now
                return names
    except Exception as e:
        logger.warning(f"system.lakeflow.pipelines not accessible: {type(e).__name__}: {e}")

    # Fall back to SDK (current workspace only)
    try:
        w = get_workspace_client()
        pipeline_names: dict[str, str] = {}
        for p in w.pipelines.list_pipelines():
            if p.pipeline_id and p.name:
                pipeline_names[p.pipeline_id] = p.name
        logger.info(f"Pipeline names from SDK: {len(pipeline_names)} found")
        _pipeline_names_cache = pipeline_names
        _pipeline_names_cache_ts = now
        return pipeline_names
    except Exception as e:
        logger.warning(f"Could not list pipelines via SDK: {type(e).__name__}: {e}")
        return {}


def _enrich_pipeline_results(results: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Enrich billing-only pipeline results with names from system table or SDK."""
    if not results:
        return results
    try:
        sdp_rows = [r for r in results if r.get("object_type") == "SDP Pipeline"]
        unresolved = [r for r in sdp_rows if r.get("object_name") == r.get("object_id")]
        if not unresolved:
            return results
        pipeline_names = _get_pipeline_names()
        if not pipeline_names:
            return results
        for row in results:
            if row.get("object_type") == "SDP Pipeline":
                pid = row.get("object_id")
                if pid and pid in pipeline_names:
                    row["object_name"] = pipeline_names[pid]
    except Exception as e:
        logger.warning(f"Pipeline enrichment failed: {type(e).__name__}: {e}")
    return results


@router.get("/dashboard-bundle")
async def get_dashboard_bundle(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get all dashboard data in a single request with parallel execution.
    
    This endpoint executes all dashboard queries in parallel to minimize latency.
    Expected speedup: 6-12x faster than making individual requests.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Execute all queries in parallel
    queries = [
        ("summary", lambda: execute_query(BILLING_SUMMARY, params)),
        ("products", lambda: execute_query(BILLING_BY_PRODUCT, params)),
        ("workspaces", lambda: execute_query(BILLING_BY_WORKSPACE, params)),
        ("timeseries", lambda: execute_query(BILLING_TIMESERIES, params)),
        ("sql_breakdown", lambda: execute_query(SQL_TOOL_ATTRIBUTION, params)),
        ("etl_breakdown", lambda: execute_query(ETL_BREAKDOWN, params)),
        ("pipeline_objects", lambda: _enrich_pipeline_results(execute_query(PIPELINE_OBJECTS, params))),
        ("interactive", lambda: execute_query(INTERACTIVE_BREAKDOWN, params)),
        ("aws_clusters", lambda: execute_query(AWS_COST_ESTIMATE, params)),
        ("aws_instances", lambda: execute_query(AWS_COST_BY_INSTANCE_TYPE, params)),
        ("aws_timeseries", lambda: execute_query(AWS_COST_TIMESERIES, params)),
    ]

    results = execute_queries_parallel(queries)

    # Format responses to match existing endpoint structures
    response = {
        "summary": _format_summary(results["summary"], params),
        "products": _format_products(results["products"], params),
        "workspaces": _format_workspaces(results["workspaces"], params),
        "timeseries": _format_timeseries(results["timeseries"], params),
        "sql_breakdown": _format_sql_breakdown(results["sql_breakdown"], params),
        "etl_breakdown": _format_etl_breakdown(results["etl_breakdown"], params),
        "pipeline_objects": _format_pipeline_objects(results["pipeline_objects"], params),
        "interactive": _format_interactive(results["interactive"], params),
        "aws": {
            "clusters": _format_aws_clusters(results["aws_clusters"], results["aws_instances"], params),
            "timeseries": _format_aws_timeseries(results["aws_timeseries"], params),
        },
    }

    return response


@router.get("/dashboard-bundle-fast")
async def get_dashboard_bundle_fast(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get essential dashboard data FAST.

    This endpoint is optimized for fast initial page load by:
    1. Using materialized views when available (sub-second queries)
    2. Falling back to optimized queries that skip system.query.history
    3. Running queries in parallel

    Expected load time: <1 second with MVs, 2-5 seconds without.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    use_mv = _check_mv_available()

    if use_mv:
        # Use materialized views — much faster than live system.billing.usage scans.
        # Fallbacks to live queries are handled in _format_summary / _format_workspaces
        # if MV returns empty (e.g. mid-rebuild on startup).
        logger.info("Using materialized views for dashboard bundle")

        def _mv_summary():
            r = _exec_mv(MV_BILLING_SUMMARY, params)
            # Fall back if empty or if MV returned zero spend (table exists but not yet populated)
            if r and float((r[0] if r else {}).get("total_spend") or 0) > 0:
                return r
            return execute_query(BILLING_SUMMARY, params)

        def _mv_timeseries():
            r = _exec_mv(MV_BILLING_TIMESERIES, params)
            return r if r else execute_query(BILLING_TIMESERIES_FAST, params)

        def _mv_products():
            r = _exec_mv(MV_BILLING_BY_PRODUCT, params)
            return r if r else execute_query(BILLING_BY_PRODUCT_FAST, params)

        def _mv_workspaces():
            r = _exec_mv(MV_BILLING_BY_WORKSPACE, params)
            return r if r else execute_query(BILLING_BY_WORKSPACE, params)

        queries = [
            ("summary", _mv_summary),
            ("products", _mv_products),
            ("workspaces", _mv_workspaces),
            ("timeseries", _mv_timeseries),
            ("etl_breakdown", lambda: _exec_mv(MV_ETL_BREAKDOWN, params)),
        ]
    else:
        # Fall back to fast queries without MVs
        # Most recent day's workspace count (matches latest point in KPI trend)
        WORKSPACE_COUNT_QUERY = """
        SELECT daily_ws as workspace_count FROM (
          SELECT usage_date, COUNT(DISTINCT workspace_id) as daily_ws
          FROM system.billing.usage
          WHERE usage_date BETWEEN :start_date AND :end_date AND usage_quantity > 0
          GROUP BY usage_date
          ORDER BY usage_date DESC
          LIMIT 1
        )
        """
        queries = [
            ("summary", lambda: execute_query(BILLING_SUMMARY, params)),
            ("products", lambda: execute_query(BILLING_BY_PRODUCT_FAST, params)),
            ("workspaces", lambda: execute_query(BILLING_BY_WORKSPACE, params)),
            ("timeseries", lambda: execute_query(BILLING_TIMESERIES_FAST, params)),
            ("etl_breakdown", lambda: execute_query(ETL_BREAKDOWN, params)),
            ("workspace_count", lambda: execute_query(WORKSPACE_COUNT_QUERY, params)),
        ]

    results = execute_queries_parallel(queries)

    # Format responses
    response = {
        "summary": _format_summary(results["summary"], params),
        "products": _format_products_fast(results["products"], params),
        "workspaces": _format_workspaces(results["workspaces"], params),
        "timeseries": _format_timeseries_fast(results["timeseries"], params),
        "etl_breakdown": _format_etl_breakdown(results["etl_breakdown"], params),
        "is_fast_mode": True,
        "using_materialized_views": use_mv,
    }

    # Without MVs: override workspace_count with accurate most-recent-day count
    if not use_mv:
        wc_results = results.get("workspace_count")
        if wc_results and len(wc_results) > 0:
            accurate_count = int(wc_results[0].get("workspace_count") or 0)
            if accurate_count > 0:
                response["summary"]["workspace_count"] = accurate_count

    return response


def _format_products_fast(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format fast products query results."""
    if not results:
        return {"products": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    products = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        products.append({
            "category": row.get("product_category"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "workspace_count": int(row.get("workspace_count") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_timeseries_fast(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format fast timeseries query results."""
    if not results:
        return {"timeseries": [], "categories": [], "start_date": params["start_date"], "end_date": params["end_date"]}

    categories = set()
    timeseries_map: dict[str, dict[str, Any]] = {}

    for row in results:
        date = str(row.get("usage_date"))
        category = row.get("product_category") or "Other"
        spend = float(row.get("total_spend") or 0)

        categories.add(category)

        if date not in timeseries_map:
            timeseries_map[date] = {"date": date}

        timeseries_map[date][category] = spend

    timeseries = sorted(timeseries_map.values(), key=lambda x: x["date"])

    return {
        "timeseries": timeseries,
        "categories": sorted(list(categories)),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_summary(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format summary query results."""
    if not results:
        return {"error": "Summary data not available"}

    row = results[0] if results else {}
    total_dbus = float(row.get("total_dbus") or 0)
    total_spend = float(row.get("total_spend") or 0)
    workspace_count = int(row.get("workspace_count") or 0)
    days_in_range = int(row.get("days_in_range") or 1)
    avg_daily_spend = total_spend / days_in_range if days_in_range > 0 else 0

    return {
        "total_dbus": total_dbus,
        "total_spend": total_spend,
        "workspace_count": workspace_count,
        "days_in_range": days_in_range,
        "avg_daily_spend": avg_daily_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
        "first_date": str(row.get("first_date")) if row.get("first_date") else None,
        "last_date": str(row.get("last_date")) if row.get("last_date") else None,
    }


def _format_products(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format products query results."""
    if not results:
        return {"products": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    products = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        products.append({
            "category": row.get("category"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "workspace_count": int(row.get("workspace_count") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_workspaces(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format workspaces query results."""
    if not results:
        return {"workspaces": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    workspaces = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        workspaces.append({
            "workspace_id": str(row.get("workspace_id")),
            "workspace_name": row.get("workspace_name") or None,
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "top_products": _ensure_list(row.get("top_products")),
            "top_users": _ensure_list(row.get("top_users")),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "workspaces": workspaces,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_timeseries(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format timeseries query results."""
    if not results:
        return {"timeseries": [], "categories": [], "start_date": params["start_date"], "end_date": params["end_date"]}

    categories = set()
    timeseries_map: dict[str, dict[str, Any]] = {}

    for row in results:
        date = str(row.get("usage_date"))
        category = row.get("category") or "Other"
        spend = float(row.get("total_spend") or 0)

        categories.add(category)

        if date not in timeseries_map:
            timeseries_map[date] = {"date": date}

        timeseries_map[date][category] = spend

    timeseries = sorted(timeseries_map.values(), key=lambda x: x["date"])

    return {
        "timeseries": timeseries,
        "categories": sorted(list(categories)),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_sql_breakdown(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format SQL breakdown query results."""
    if not results:
        return {"products": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    products = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        products.append({
            "product": row.get("product"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "products": products,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_etl_breakdown(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format ETL breakdown query results."""
    return _format_sql_breakdown(results, params)  # Same format


def _format_pipeline_objects(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format pipeline objects query results."""
    if not results:
        return {"objects": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    objects = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        objects.append({
            "object_type": row.get("object_type"),
            "object_id": row.get("object_id"),
            "object_name": row.get("object_name"),
            "workspace_id": str(row.get("workspace_id") or ""),
            "object_state": row.get("object_state"),
            "owner": row.get("owner"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "total_runs": int(row.get("total_runs") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "objects": objects,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_interactive(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format interactive breakdown query results."""
    if not results:
        return {"items": [], "total_spend": 0, "start_date": params["start_date"], "end_date": params["end_date"]}

    total_spend = sum(float(row.get("total_spend") or 0) for row in results)
    items = []
    for row in results:
        spend = float(row.get("total_spend") or 0)
        items.append({
            "cluster_id": row.get("cluster_id"),
            "notebook_path": row.get("notebook_path"),
            "user": row.get("run_as_user"),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": spend,
            "days_active": int(row.get("days_active") or 0),
            "notebook_count": int(row.get("notebook_count") or 0),
            "percentage": (spend / total_spend * 100) if total_spend > 0 else 0,
        })

    return {
        "items": items,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


def _format_aws_clusters(
    cluster_results: list[dict[str, Any]] | None,
    instance_results: list[dict[str, Any]] | None,
    params: dict[str, str]
) -> dict[str, Any]:
    """Format AWS costs query results."""
    if not cluster_results:
        return {"clusters": [], "instance_families": [], "total_estimated_cost": 0, "total_dbu_hours": 0,
                "start_date": params["start_date"], "end_date": params["end_date"]}

    total_cost = sum(float(row.get("estimated_aws_cost") or 0) for row in cluster_results)
    total_dbu_hours = sum(float(row.get("total_dbu_hours") or 0) for row in cluster_results)

    clusters = []
    for row in cluster_results:
        cost = float(row.get("estimated_aws_cost") or 0)
        clusters.append({
            "cluster_id": row.get("cluster_id"),
            "cluster_name": row.get("cluster_name"),
            "driver_instance_type": row.get("driver_instance_type"),
            "worker_instance_type": row.get("worker_instance_type"),
            "cluster_source": row.get("cluster_source"),
            "total_dbu_hours": float(row.get("total_dbu_hours") or 0),
            "estimated_aws_cost": cost,
            "days_active": int(row.get("days_active") or 0),
            "percentage": (cost / total_cost * 100) if total_cost > 0 else 0,
        })

    instance_families = []
    if instance_results:
        for row in instance_results:
            instance_families.append({
                "instance_family": row.get("instance_family"),
                "total_dbu_hours": float(row.get("total_dbu_hours") or 0),
                "days_active": int(row.get("days_active") or 0),
            })

    return {
        "clusters": clusters,
        "instance_families": instance_families,
        "total_estimated_cost": total_cost,
        "total_dbu_hours": total_dbu_hours,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
        "disclaimer": "Estimated AWS costs based on standard EC2 pricing. Actual costs may vary.",
    }


def _format_aws_timeseries(results: list[dict[str, Any]] | None, params: dict[str, str]) -> dict[str, Any]:
    """Format AWS timeseries query results with instance family breakdown."""
    if not results:
        return {"timeseries": [], "instance_families": [], "start_date": params["start_date"], "end_date": params["end_date"]}

    # Aggregate by date, with per-family breakdown
    from collections import defaultdict
    date_totals: dict[str, float] = defaultdict(float)
    date_family: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    all_families: set[str] = set()

    for row in results:
        d = str(row.get("usage_date"))
        family = row.get("instance_family") or "unknown"
        cost = float(row.get("estimated_aws_cost") or 0)
        date_totals[d] += cost
        date_family[d][family] += cost
        all_families.add(family)

    # Build timeseries with total + per-family columns
    timeseries = []
    for d in sorted(date_totals.keys()):
        entry: dict[str, Any] = {"date": d, "AWS Cost": round(date_totals[d], 2)}
        for family in all_families:
            entry[family] = round(date_family[d].get(family, 0), 2)
        timeseries.append(entry)

    # Sort families by total spend descending
    family_totals = {f: sum(date_family[d].get(f, 0) for d in date_totals) for f in all_families}
    sorted_families = sorted(all_families, key=lambda f: family_totals[f], reverse=True)

    return {
        "timeseries": timeseries,
        "instance_families": sorted_families,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/sku-breakdown")
async def get_sku_breakdown(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    workspace_id: str = Query(default=None, description="Filter by workspace ID"),
) -> dict[str, Any]:
    """Get breakdown by SKU/product type.

    Returns spend and usage metrics grouped by SKU name.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    if workspace_id:
        params["workspace_id"] = workspace_id
        query = SKU_BREAKDOWN.replace(
            "WHERE u.usage_date >= :start_date",
            "WHERE CAST(u.workspace_id AS STRING) = :workspace_id\n  AND u.usage_date >= :start_date",
        )
        results = execute_query(query, params)
    else:
        results = execute_query(SKU_BREAKDOWN, params)

    skus = []
    total_spend = 0.0

    for row in results:
        sku = {
            "product": row.get("product"),
            "workspaces_using": int(row.get("workspaces_using") or 0),
            "total_dbus": float(row.get("total_dbus") or 0),
            "total_spend": float(row.get("total_spend") or 0),
            "percentage": float(row.get("percentage") or 0),
        }
        skus.append(sku)
        total_spend += sku["total_spend"]

    return {
        "skus": skus,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


_group_membership_cache: dict[str, list[str]] | None = None
_group_membership_cache_ts: float = 0
_GROUP_CACHE_TTL = 3600  # 1 hour


def _get_cached_group_membership(w) -> dict[str, list[str]]:
    """Get user→groups mapping from SDK, cached for 1 hour."""
    global _group_membership_cache, _group_membership_cache_ts
    import time as _time
    now = _time.monotonic()
    if _group_membership_cache is not None and (now - _group_membership_cache_ts) < _GROUP_CACHE_TTL:
        return _group_membership_cache

    user_groups: dict[str, list[str]] = {}
    for g in w.groups.list(attributes="displayName,members", filter='displayName co ""'):
        if not g.display_name or not g.members:
            continue
        for m in g.members:
            if m.display and "@" in m.display:
                user_groups.setdefault(m.display, []).append(g.display_name)

    _group_membership_cache = user_groups
    _group_membership_cache_ts = now
    return user_groups


@router.get("/spend-by-user-group")
async def get_spend_by_user_group(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get spend breakdown by user group (falls back to top users)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Try user groups first via Databricks SDK (cached for 1 hour)
    groups = []
    total_spend = 0.0
    source = "users"

    try:
        w = get_workspace_client()
        # Build group membership map: user_name -> list of group names
        user_groups = _get_cached_group_membership(w)

        if user_groups:
            source = "groups"
            # Get per-user spend
            user_query = """
            SELECT
              COALESCE(u.identity_metadata.run_as, 'Unknown') as user_identity,
              SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
              SUM(u.usage_quantity) as total_dbus
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices p
              ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
            WHERE u.usage_date BETWEEN :start_date AND :end_date
              AND u.usage_quantity > 0
              AND u.identity_metadata.run_as IS NOT NULL
              AND u.identity_metadata.run_as != 'Unknown'
            GROUP BY 1
            HAVING SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) > 0
            """
            user_results = execute_query(user_query, params)

            # Aggregate spend by group
            group_spend: dict[str, dict] = {}
            for row in (user_results or []):
                user = row.get("user_identity") or ""
                spend = float(row.get("total_spend") or 0)
                dbus = float(row.get("total_dbus") or 0)
                matched_groups = user_groups.get(user, ["No Group"])
                for gname in matched_groups:
                    if gname not in group_spend:
                        group_spend[gname] = {"total_spend": 0, "total_dbus": 0, "user_count": set()}
                    group_spend[gname]["total_spend"] += spend
                    group_spend[gname]["total_dbus"] += dbus
                    group_spend[gname]["user_count"].add(user)

            for gname, data in sorted(group_spend.items(), key=lambda x: x[1]["total_spend"], reverse=True)[:15]:
                groups.append({
                    "group_name": gname,
                    "total_spend": data["total_spend"],
                    "total_dbus": data["total_dbus"],
                    "user_count": len(data["user_count"]),
                })
                total_spend += data["total_spend"]
    except Exception as e:
        logger.warning(f"Group lookup failed, falling back to users: {e}")

    # Fallback: top users by spend
    if not groups:
        source = "users"
        query = """
        SELECT
          u.identity_metadata.run_as as group_name,
          SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
          SUM(u.usage_quantity) as total_dbus,
          1 as user_count
        FROM system.billing.usage u
        LEFT JOIN system.billing.list_prices p
          ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.identity_metadata.run_as IS NOT NULL
        GROUP BY 1
        HAVING SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) > 0
        ORDER BY total_spend DESC
        LIMIT 15
        """
        try:
            results = execute_query(query, params)
        except Exception as e:
            logger.warning(f"User spend query failed: {e}")
            return {"groups": [], "total_spend": 0, "error": str(e)}

        for row in (results or []):
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            name = row.get("group_name") or ""
            if not name or name == "Unknown":
                continue
            groups.append({
                "group_name": name.split("@")[0] if "@" in name else name,
                "total_spend": spend,
                "total_dbus": float(row.get("total_dbus") or 0),
                "user_count": int(row.get("user_count") or 0),
            })

    # Calculate percentages
    for g in groups:
        g["percentage"] = round((g["total_spend"] / total_spend * 100) if total_spend > 0 else 0, 1)

    return {
        "groups": groups,
        "total_spend": total_spend,
        "source": source,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/spend-anomalies")
async def get_spend_anomalies(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get days with largest day-over-day spend changes.

    Returns top 20 days with biggest absolute percentage changes in spend.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(SPEND_ANOMALIES, params)

    anomalies = []

    for row in results:
        anomaly = {
            "usage_date": str(row.get("usage_date")),
            "daily_spend": float(row.get("daily_spend") or 0),
            "prev_day_spend": float(row.get("prev_day_spend") or 0),
            "change_amount": float(row.get("change_amount") or 0),
            "change_percent": float(row.get("change_percent") or 0),
        }
        anomalies.append(anomaly)

    return {
        "anomalies": anomalies,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/platform-kpis")
async def get_platform_kpis(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    fast: bool = Query(default=True, description="Use fast mode (skips query.history)"),
) -> dict[str, Any]:
    """Get platform KPIs showing value and accomplishments.

    Returns key metrics like total queries, jobs, data processed,
    unique users, and other metrics demonstrating platform value.

    Set fast=true (default) to skip slow query.history joins.
    When materialized views are available, query stats are included even in fast mode.
    """
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Initialize response with defaults
    response = {
        "total_queries": 0,
        "unique_query_users": 0,
        "total_rows_read": 0,
        "total_bytes_read": 0,
        "total_compute_seconds": 0,
        "total_jobs": 0,
        "total_job_runs": 0,
        "successful_runs": 0,
        "unique_job_owners": 0,
        "active_workspaces": 0,
        "active_notebooks": 0,
        "models_served": 0,
        "total_serving_dbus": 0,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }

    # Check if we can use materialized views for query stats
    use_mv = _check_mv_available()

    if use_mv:
        # Try to get query stats from materialized view (fast!)
        try:
            mv_results = _exec_mv(MV_PLATFORM_KPIS, params)
            if mv_results and len(mv_results) > 0:
                mv_row = mv_results[0]
                response["total_queries"] = int(mv_row.get("total_queries") or 0)
                response["unique_query_users"] = int(mv_row.get("unique_query_users") or 0)
                response["total_rows_read"] = int(mv_row.get("total_rows_read") or 0)
                response["total_bytes_read"] = int(mv_row.get("total_bytes_read") or 0)
                response["total_compute_seconds"] = float(mv_row.get("total_compute_seconds") or 0)
                logger.info("Platform KPIs: Using materialized views for query stats")
        except Exception as e:
            logger.debug(f"MV query stats failed: {e}")

    # Get billing-based stats (always use fast query for these)
    query = PLATFORM_KPIS_FAST if fast or use_mv else PLATFORM_KPIS
    results = execute_query(query, params)

    if results and len(results) > 0:
        row = results[0]

        # If we didn't get query stats from MV, try to get them from the query results
        if not use_mv and not fast:
            response["total_queries"] = int(row.get("total_queries") or 0)
            response["unique_query_users"] = int(row.get("unique_query_users") or 0)
            response["total_rows_read"] = int(row.get("total_rows_read") or 0)
            response["total_bytes_read"] = int(row.get("total_bytes_read") or 0)
            response["total_compute_seconds"] = float(row.get("total_compute_seconds") or 0)

        # Always get billing-based metrics (including unique_job_owners and lakeflow stats)
        response["total_jobs"] = int(row.get("total_jobs") or 0)
        response["total_job_runs"] = int(row.get("total_job_runs") or 0)
        response["successful_runs"] = int(row.get("successful_runs") or 0)
        response["unique_job_owners"] = int(row.get("unique_job_owners") or 0)
        response["active_workspaces"] = int(row.get("active_workspaces") or 0)
        response["active_notebooks"] = int(row.get("active_notebooks") or 0)
        response["models_served"] = int(row.get("models_served") or 0)
        response["total_serving_dbus"] = float(row.get("total_serving_dbus") or 0)

    return response


@router.get("/kpis-bundle")
async def get_kpis_bundle(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Bundled KPIs endpoint: runs platform KPIs and spend anomalies in parallel."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Determine which KPI query to run
    use_mv = _check_mv_available()
    kpi_query = PLATFORM_KPIS_FAST  # Always use fast mode for bundle

    # Supplemental query for accurate user count (MV uses MAX of daily counts which under-counts)
    catalog, schema = get_catalog_schema()
    USER_COUNT_QUERY = f"""
    SELECT COUNT(DISTINCT executed_by) as unique_query_users
    FROM {catalog}.{schema}.dbsql_cost_per_query
    WHERE start_time >= :start_date AND start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
    """

    # Direct Delta query for query stats — used as fallback if Lakebase daily_query_stats is empty
    delta_query_stats_sql = MV_PLATFORM_KPIS.format(catalog=catalog, schema=schema)

    # Build parallel query list
    parallel_queries: list[tuple[str, Any]] = [
        ("kpis", lambda: execute_query(kpi_query, params)),
        ("anomalies", lambda: execute_query(SPEND_ANOMALIES, params)),
        ("delta_query_stats", lambda: execute_query(delta_query_stats_sql, params)),
    ]

    # Add MV query if available
    if use_mv:
        parallel_queries.append(("mv_kpis", lambda: _exec_mv(MV_PLATFORM_KPIS, params)))

    # Add supplemental user count query (runs in parallel, fast from materialized table)
    try:
        parallel_queries.append(("user_count", lambda: execute_query(USER_COUNT_QUERY, params)))
    except Exception:
        pass  # prpr table may not exist

    query_results = execute_queries_parallel(parallel_queries)

    # --- Build KPIs response ---
    kpis_response = {
        "total_queries": 0, "unique_query_users": 0,
        "total_rows_read": 0, "total_bytes_read": 0, "total_compute_seconds": 0,
        "total_jobs": 0, "total_job_runs": 0, "successful_runs": 0,
        "unique_job_owners": 0, "active_workspaces": 0, "active_notebooks": 0,
        "models_served": 0, "total_serving_dbus": 0,
        "start_date": params["start_date"], "end_date": params["end_date"],
    }

    # Apply query stats: MV (Lakebase) first, fall back to Delta if result is empty/zero
    def _apply_query_stats(row: dict) -> None:
        kpis_response["total_queries"] = int(row.get("total_queries") or 0)
        kpis_response["unique_query_users"] = int(row.get("unique_query_users") or 0)
        kpis_response["total_rows_read"] = int(row.get("total_rows_read") or 0)
        kpis_response["total_bytes_read"] = int(row.get("total_bytes_read") or 0)
        kpis_response["total_compute_seconds"] = float(row.get("total_compute_seconds") or 0)

    mv_results = query_results.get("mv_kpis")
    mv_has_data = mv_results and len(mv_results) > 0 and int(mv_results[0].get("total_queries") or 0) > 0
    if mv_has_data:
        _apply_query_stats(mv_results[0])
    else:
        # Lakebase daily_query_stats may be empty — use Delta copy directly
        delta_qs = query_results.get("delta_query_stats")
        if delta_qs and len(delta_qs) > 0:
            _apply_query_stats(delta_qs[0])

    kpi_results = query_results.get("kpis")
    if kpi_results and len(kpi_results) > 0:
        row = kpi_results[0]
        kpis_response["total_jobs"] = int(row.get("total_jobs") or 0)
        kpis_response["total_job_runs"] = int(row.get("total_job_runs") or 0)
        kpis_response["successful_runs"] = int(row.get("successful_runs") or 0)
        kpis_response["unique_job_owners"] = int(row.get("unique_job_owners") or 0)
        kpis_response["active_workspaces"] = int(row.get("active_workspaces") or 0)
        kpis_response["active_notebooks"] = int(row.get("active_notebooks") or 0)
        kpis_response["models_served"] = int(row.get("models_served") or 0)
        kpis_response["total_serving_dbus"] = float(row.get("total_serving_dbus") or 0)

    # Override unique_query_users with accurate cross-range distinct count from prpr table
    uc_results = query_results.get("user_count")
    if uc_results and len(uc_results) > 0:
        accurate_users = int(uc_results[0].get("unique_query_users") or 0)
        if accurate_users > 0:
            kpis_response["unique_query_users"] = accurate_users

    # --- Build anomalies response ---
    anomaly_results = query_results.get("anomalies") or []
    anomalies = []
    for row in anomaly_results:
        anomalies.append({
            "usage_date": str(row.get("usage_date")),
            "daily_spend": float(row.get("daily_spend") or 0),
            "prev_day_spend": float(row.get("prev_day_spend") or 0),
            "change_amount": float(row.get("change_amount") or 0),
            "change_percent": float(row.get("change_percent") or 0),
        })

    return {
        "kpis": kpis_response,
        "anomalies": {
            "anomalies": anomalies,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        },
    }


@router.get("/kpi-trend")
async def get_kpi_trend(
    kpi: str = Query(..., description="KPI to fetch trend for: total_spend, total_dbus, avg_daily_spend, workspace_count, aiml_spend, aiml_dbus, aiml_endpoints, tagged_spend, untagged_spend, infra_cost, infra_clusters, infra_dbu_hours"),
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    granularity: str = Query("daily", description="Granularity: daily, weekly, monthly"),
) -> dict[str, Any]:
    """Get trend data for a specific KPI over time."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    use_mv = _check_mv_available()

    # Build query based on KPI type — use MVs when available for daily-aggregation KPIs
    # mv_fallback_query is set when using an MV so we can fall back to live if MV is empty
    mv_fallback_query = None

    if kpi == "total_spend" or kpi == "avg_daily_spend":
        if use_mv:
            catalog, schema = get_catalog_schema()
            query = f"SELECT usage_date as date, total_spend as value FROM {catalog}.{schema}.daily_usage_summary WHERE usage_date BETWEEN :start_date AND :end_date ORDER BY usage_date"
            mv_fallback_query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
        else:
            query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "total_dbus":
        if use_mv:
            catalog, schema = get_catalog_schema()
            query = f"SELECT usage_date as date, total_dbus as value FROM {catalog}.{schema}.daily_usage_summary WHERE usage_date BETWEEN :start_date AND :end_date ORDER BY usage_date"
            mv_fallback_query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
        else:
            query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "workspace_count":
        if use_mv:
            catalog, schema = get_catalog_schema()
            query = f"SELECT usage_date as date, workspace_count as value FROM {catalog}.{schema}.daily_usage_summary WHERE usage_date BETWEEN :start_date AND :end_date ORDER BY usage_date"
            mv_fallback_query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT workspace_id) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
        else:
            query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT workspace_id) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "aiml_spend":
        query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND (
              u.billing_origin_product = 'MODEL_SERVING'
              OR u.sku_name LIKE '%SERVERLESS_REAL_TIME_INFERENCE%'
              OR u.sku_name LIKE '%ANTHROPIC%'
              OR u.sku_name LIKE '%OPENAI%'
              OR u.sku_name LIKE '%GEMINI%'
              OR u.sku_name LIKE '%INFERENCE%'
            )
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "aiml_dbus":
        query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND (
            billing_origin_product = 'MODEL_SERVING'
            OR sku_name LIKE '%SERVERLESS_REAL_TIME_INFERENCE%'
            OR sku_name LIKE '%ANTHROPIC%'
            OR sku_name LIKE '%OPENAI%'
            OR sku_name LIKE '%GEMINI%'
            OR sku_name LIKE '%INFERENCE%'
          )
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "aiml_endpoints":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.endpoint_name) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND (
            billing_origin_product = 'MODEL_SERVING'
            OR sku_name LIKE '%SERVERLESS_REAL_TIME_INFERENCE%'
            OR sku_name LIKE '%INFERENCE%'
          )
          AND usage_metadata.endpoint_name IS NOT NULL
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "tagged_spend":
        query = """
        WITH usage_with_tags AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu,
            CASE WHEN u.custom_tags IS NOT NULL AND size(u.custom_tags) > 0 THEN true ELSE false END as has_tags
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(CASE WHEN has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as value
        FROM usage_with_tags
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "untagged_spend":
        query = """
        WITH usage_with_tags AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu,
            CASE WHEN u.custom_tags IS NOT NULL AND size(u.custom_tags) > 0 THEN true ELSE false END as has_tags
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
        )
        SELECT
          usage_date as date,
          SUM(CASE WHEN NOT has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as value
        FROM usage_with_tags
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "infra_cost":
        query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND (u.sku_name LIKE '%ALL_PURPOSE%' OR u.sku_name LIKE '%JOBS%' OR u.sku_name LIKE '%SQL%' OR u.sku_name LIKE '%DLT%')
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "infra_clusters":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.cluster_id) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND usage_metadata.cluster_id IS NOT NULL
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "infra_dbu_hours":
        query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND (sku_name LIKE '%ALL_PURPOSE%' OR sku_name LIKE '%JOBS%' OR sku_name LIKE '%DLT%')
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "avg_cost_per_cluster":
        query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            u.usage_metadata.cluster_id as cluster_id,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.usage_metadata.cluster_id IS NOT NULL
            AND (u.sku_name LIKE '%ALL_PURPOSE%' OR u.sku_name LIKE '%JOBS%' OR u.sku_name LIKE '%DLT%')
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) / NULLIF(COUNT(DISTINCT cluster_id), 0) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_spend":
        query = """
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.billing_origin_product = 'APPS'
        )
        SELECT
          usage_date as date,
          SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_dbus":
        query = """
        SELECT
          usage_date as date,
          SUM(usage_quantity) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND billing_origin_product = 'APPS'
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_count":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT COALESCE(usage_metadata.app_id, 'unknown')) as value
        FROM system.billing.usage
        WHERE usage_date BETWEEN :start_date AND :end_date
          AND usage_quantity > 0
          AND billing_origin_product = 'APPS'
        GROUP BY usage_date
        ORDER BY usage_date
        """
    else:
        return {"error": f"Unknown KPI: {kpi}"}

    try:
        results = execute_query(query, params)
        if not results and mv_fallback_query:
            logger.info(f"KPI trend MV returned empty for {kpi}, falling back to live query")
            results = execute_query(mv_fallback_query, params)
    except Exception as e:
        logger.error(f"KPI trend query failed for {kpi}: {e}")
        if mv_fallback_query:
            try:
                results = execute_query(mv_fallback_query, params)
            except Exception:
                results = []
        if not results:
            return {
                "kpi": kpi,
                "granularity": granularity,
                "data_points": [],
                "summary": {
                    "period_start_value": 0,
                    "period_end_value": 0,
                    "change_amount": 0,
                    "change_percent": 0,
                    "min_value": 0,
                    "max_value": 0,
                    "avg_value": 0,
                    "trend": "flat",
                },
            }

    # Process results into daily data points
    daily_points = []
    for row in results:
        daily_points.append({
            "date": str(row["date"]),
            "value": float(row["value"] or 0)
        })

    # KPIs that represent averages/rates — use AVG when grouping into buckets
    AVG_KPIS = {"avg_cost_per_cluster", "avg_daily_spend"}

    # Group into weekly/monthly buckets if needed
    if granularity == "weekly" and daily_points:
        from datetime import datetime, timedelta
        buckets: dict[str, list[float]] = {}
        for dp in daily_points:
            d = datetime.strptime(dp["date"], "%Y-%m-%d")
            week_start = d - timedelta(days=d.weekday())
            key = week_start.strftime("%Y-%m-%d")
            buckets.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets.keys()):
            vals = buckets[key]
            agg = sum(vals) / len(vals) if kpi in AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    elif granularity == "monthly" and daily_points:
        buckets_m: dict[str, list[float]] = {}
        for dp in daily_points:
            key = dp["date"][:7] + "-01"
            buckets_m.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets_m.keys()):
            vals = buckets_m[key]
            agg = sum(vals) / len(vals) if kpi in AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    else:
        data_points = daily_points

    # Calculate summary statistics
    all_values = [dp["value"] for dp in data_points]

    if not data_points:
        return {
            "kpi": kpi,
            "granularity": granularity,
            "data_points": [],
            "summary": {
                "period_start_value": 0,
                "period_end_value": 0,
                "change_amount": 0,
                "change_percent": 0,
                "min_value": 0,
                "max_value": 0,
                "avg_value": 0,
                "trend": "flat"
            }
        }

    period_start_value = all_values[0]
    period_end_value = all_values[-1]
    change_amount = period_end_value - period_start_value
    change_percent = (change_amount / period_start_value * 100) if period_start_value > 0 else 0

    # Determine trend
    if abs(change_percent) < 5:
        trend = "flat"
    elif change_percent > 0:
        trend = "increasing"
    else:
        trend = "decreasing"

    return {
        "kpi": kpi,
        "granularity": granularity,
        "data_points": data_points,
        "summary": {
            "period_start_value": round(period_start_value, 2),
            "period_end_value": round(period_end_value, 2),
            "change_amount": round(change_amount, 2),
            "change_percent": round(change_percent, 2),
            "min_value": round(min(all_values), 2),
            "max_value": round(max(all_values), 2),
            "avg_value": round(sum(all_values) / len(all_values), 2),
            "trend": trend
        }
    }

def _build_platform_kpi_response(kpi: str, granularity: str, data_points: list[dict]) -> dict[str, Any]:
    """Build the standard platform KPI trend response from a list of {date, value} points."""
    PLATFORM_AVG_KPIS = {"avg_query_duration"}
    all_values = [dp["value"] for dp in data_points]
    if not data_points:
        return {"kpi": kpi, "granularity": granularity, "data_points": [], "summary": {
            "period_start_value": 0, "period_end_value": 0, "change_amount": 0,
            "change_percent": 0, "min_value": 0, "max_value": 0, "avg_value": 0, "trend": "flat"
        }}
    period_start_value = all_values[0]
    period_end_value = all_values[-1]
    change_amount = period_end_value - period_start_value
    change_percent = (change_amount / period_start_value * 100) if period_start_value > 0 else 0
    trend = "flat" if abs(change_percent) < 5 else ("increasing" if change_percent > 0 else "decreasing")
    return {
        "kpi": kpi, "granularity": granularity, "data_points": data_points,
        "summary": {
            "period_start_value": round(period_start_value, 2),
            "period_end_value": round(period_end_value, 2),
            "change_amount": round(change_amount, 2),
            "change_percent": round(change_percent, 2),
            "min_value": round(min(all_values), 2),
            "max_value": round(max(all_values), 2),
            "avg_value": round(sum(all_values) / len(all_values), 2),
            "trend": trend,
        }
    }


@router.get("/platform-kpi-trend")
async def get_platform_kpi_trend(
    kpi: str = Query(..., description="Platform KPI: total_queries, total_rows_read, total_bytes_read, total_compute_seconds, total_jobs, total_job_runs, successful_runs, active_notebooks, active_workspaces, models_served, total_users"),
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
    granularity: str = Query("daily", description="Granularity: daily, weekly, monthly"),
) -> dict[str, Any]:
    """Get trend data for platform KPIs over time."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # For DISTINCT COUNT KPIs, monthly/weekly rollup must be done in SQL — summing
    # daily distinct counts in Python overcounts (user active 30 days = 30x, not 1x).
    # We re-query with DATE_TRUNC grouping so the DB computes true monthly/weekly uniques.
    DATE_TRUNC_MAP = {"weekly": "WEEK", "monthly": "MONTH"}
    if granularity in DATE_TRUNC_MAP:
        trunc = DATE_TRUNC_MAP[granularity]
        if kpi == "total_users":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', DATE(start_time)) as date,
              COUNT(DISTINCT COALESCE(executed_by, executed_as_user_id)) as value
            FROM system.query.history
            WHERE start_time >= CAST(:start_date AS TIMESTAMP)
              AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
              AND (executed_by IS NOT NULL OR executed_as_user_id IS NOT NULL)
            GROUP BY DATE_TRUNC('{trunc}', DATE(start_time))
            ORDER BY date
            """
            results = execute_query(query, params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _build_platform_kpi_response(kpi, granularity, daily_points)
        elif kpi == "active_workspaces":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', usage_date) as date,
              COUNT(DISTINCT workspace_id) as value
            FROM system.billing.usage
            WHERE usage_date >= :start_date AND usage_date <= :end_date AND usage_quantity > 0
            GROUP BY DATE_TRUNC('{trunc}', usage_date)
            ORDER BY date
            """
            results = execute_query(query, params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _build_platform_kpi_response(kpi, granularity, daily_points)
        elif kpi == "total_jobs":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', usage_date) as date,
              COUNT(DISTINCT usage_metadata.job_id) as value
            FROM system.billing.usage
            WHERE usage_date >= :start_date AND usage_date <= :end_date
              AND usage_metadata.job_id IS NOT NULL AND usage_quantity > 0
            GROUP BY DATE_TRUNC('{trunc}', usage_date)
            ORDER BY date
            """
            results = execute_query(query, params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _build_platform_kpi_response(kpi, granularity, daily_points)
        elif kpi == "models_served":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', usage_date) as date,
              COUNT(DISTINCT usage_metadata.endpoint_name) as value
            FROM system.billing.usage
            WHERE usage_date >= :start_date AND usage_date <= :end_date
              AND sku_name LIKE '%INFERENCE%' AND usage_quantity > 0
            GROUP BY DATE_TRUNC('{trunc}', usage_date)
            ORDER BY date
            """
            results = execute_query(query, params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _build_platform_kpi_response(kpi, granularity, daily_points)
        elif kpi == "unique_warehouses":
            query = f"""
            SELECT
              DATE_TRUNC('{trunc}', DATE(start_time)) as date,
              COUNT(DISTINCT warehouse_id) as value
            FROM system.query.history
            WHERE start_time >= CAST(:start_date AS TIMESTAMP)
              AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
              AND warehouse_id IS NOT NULL
            GROUP BY DATE_TRUNC('{trunc}', DATE(start_time))
            ORDER BY date
            """
            results = execute_query(query, params)
            daily_points = [{"date": str(r["date"])[:10], "value": float(r["value"] or 0)} for r in results]
            return _build_platform_kpi_response(kpi, granularity, daily_points)

    # Build query based on KPI type
    # Use explicit TIMESTAMP casts for partition-aware date filtering on system.query.history
    if kpi == "total_queries":
        query = """
        SELECT
          DATE(start_time) as date,
          COUNT(*) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_rows_read":
        query = """
        SELECT
          DATE(start_time) as date,
          SUM(COALESCE(read_rows, 0)) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_bytes_read":
        query = """
        SELECT
          DATE(start_time) as date,
          SUM(COALESCE(read_bytes, 0)) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_compute_seconds":
        query = """
        SELECT
          DATE(start_time) as date,
          SUM(COALESCE(total_task_duration_ms, 0)) / 1000.0 as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "total_jobs":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.job_id) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND usage_metadata.job_id IS NOT NULL
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "total_job_runs":
        query = """
        SELECT
          usage_date as date,
          COUNT(*) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND usage_metadata.job_id IS NOT NULL
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "successful_runs":
        query = """
        SELECT
          DATE(period_start_time) as date,
          COUNT(CASE WHEN result_state = 'SUCCEEDED' THEN 1 END) as value
        FROM system.lakeflow.job_run_timeline
        WHERE period_start_time >= :start_date
          AND period_start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
        GROUP BY DATE(period_start_time)
        ORDER BY DATE(period_start_time)
        """
    elif kpi == "active_notebooks":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.cluster_id) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND usage_metadata.cluster_id IS NOT NULL
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "active_workspaces":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT workspace_id) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "models_served":
        query = """
        SELECT
          usage_date as date,
          COUNT(DISTINCT usage_metadata.endpoint_name) as value
        FROM system.billing.usage
        WHERE usage_date >= :start_date
          AND usage_date <= :end_date
          AND sku_name LIKE '%INFERENCE%'
          AND usage_quantity > 0
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "total_users":
        query = """
        SELECT
          DATE(start_time) as date,
          COUNT(DISTINCT COALESCE(executed_by, executed_as_user_id)) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
          AND (executed_by IS NOT NULL OR executed_as_user_id IS NOT NULL)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "avg_query_duration":
        query = """
        SELECT
          DATE(start_time) as date,
          AVG(COALESCE(total_task_duration_ms, 0)) / 1000.0 as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    elif kpi == "unique_warehouses":
        query = """
        SELECT
          DATE(start_time) as date,
          COUNT(DISTINCT warehouse_id) as value
        FROM system.query.history
        WHERE start_time >= CAST(:start_date AS TIMESTAMP)
          AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
          AND warehouse_id IS NOT NULL
        GROUP BY DATE(start_time)
        ORDER BY DATE(start_time)
        """
    else:
        return {"error": f"Unknown platform KPI: {kpi}"}

    try:
        results = execute_query(query, params)
    except Exception as e:
        logger.error(f"Platform KPI trend query failed for {kpi}: {e}")
        return {
            "kpi": kpi,
            "granularity": granularity,
            "data_points": [],
            "summary": {
                "period_start_value": 0,
                "period_end_value": 0,
                "change_amount": 0,
                "change_percent": 0,
                "min_value": 0,
                "max_value": 0,
                "avg_value": 0,
                "trend": "flat"
            }
        }

    # Process results into daily data points
    daily_points = []
    for row in results:
        daily_points.append({
            "date": str(row["date"]),
            "value": float(row["value"] or 0)
        })

    # KPIs that represent averages/rates — use AVG when grouping into buckets
    PLATFORM_AVG_KPIS = {"avg_query_duration"}

    # Group into weekly/monthly buckets if needed
    if granularity == "weekly" and daily_points:
        from datetime import datetime, timedelta
        buckets: dict[str, list[float]] = {}
        for dp in daily_points:
            d = datetime.strptime(dp["date"], "%Y-%m-%d")
            week_start = d - timedelta(days=d.weekday())
            key = week_start.strftime("%Y-%m-%d")
            buckets.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets.keys()):
            vals = buckets[key]
            agg = sum(vals) / len(vals) if kpi in PLATFORM_AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    elif granularity == "monthly" and daily_points:
        buckets_m: dict[str, list[float]] = {}
        for dp in daily_points:
            key = dp["date"][:7] + "-01"
            buckets_m.setdefault(key, []).append(dp["value"])
        data_points = []
        for key in sorted(buckets_m.keys()):
            vals = buckets_m[key]
            agg = sum(vals) / len(vals) if kpi in PLATFORM_AVG_KPIS else sum(vals)
            data_points.append({"date": key, "value": agg})
    else:
        data_points = daily_points

    # Calculate summary statistics
    # Use all values (including zeros) for data points, but filter for summary
    all_values = [dp["value"] for dp in data_points]
    positive_values = [v for v in all_values if v > 0]

    if not data_points:
        return {
            "kpi": kpi,
            "granularity": granularity,
            "data_points": [],
            "summary": {
                "period_start_value": 0,
                "period_end_value": 0,
                "change_amount": 0,
                "change_percent": 0,
                "min_value": 0,
                "max_value": 0,
                "avg_value": 0,
                "trend": "flat"
            }
        }

    # Use all_values for start/end, positive_values for min/max/avg
    values = positive_values if positive_values else all_values

    period_start_value = values[0] if values else 0
    period_end_value = values[-1] if values else 0
    change_amount = period_end_value - period_start_value
    change_percent = (change_amount / period_start_value * 100) if period_start_value > 0 else 0

    # Determine trend
    if abs(change_percent) < 5:
        trend = "flat"
    elif change_percent > 0:
        trend = "increasing"
    else:
        trend = "decreasing"

    return {
        "kpi": kpi,
        "granularity": granularity,
        "data_points": data_points,
        "summary": {
            "period_start_value": round(period_start_value, 2),
            "period_end_value": round(period_end_value, 2),
            "change_amount": round(change_amount, 2),
            "change_percent": round(change_percent, 2),
            "min_value": round(min(values), 2),
            "max_value": round(max(values), 2),
            "avg_value": round(sum(values) / len(values), 2),
            "trend": trend
        }
    }


@router.get("/contract-burndown")
async def get_contract_burndown() -> dict[str, Any]:
    """Return contract burn-down data: KPIs + daily cumulative series vs ideal pace.

    Reads contract terms from .settings/contract_settings.json.
    If not configured, returns {"configured": false}.
    """
    from datetime import date as _date, timedelta as _td
    from server.routers.settings import _load_contract_settings

    contract = _load_contract_settings()

    start_str = contract.get("start_date") or ""
    end_str = contract.get("end_date") or ""
    total_commit = contract.get("total_commit_usd")
    if not start_str or not end_str or not total_commit:
        return {"configured": False}

    try:
        start_date = _date.fromisoformat(start_str)
        end_date = _date.fromisoformat(end_str)
    except ValueError:
        return {"configured": False, "error": "Invalid date format in contract settings"}

    total_days = (end_date - start_date).days
    if total_days <= 0:
        return {"configured": False, "error": "end_date must be after start_date"}

    today = _date.today()
    query_end = min(today, end_date)

    catalog, schema = get_catalog_schema()
    import asyncio as _asyncio
    _sql = (
        f"SELECT usage_date, total_spend FROM `{catalog}`.`{schema}`.`daily_usage_summary`"
        f" WHERE usage_date >= '{start_str}' AND usage_date <= '{query_end.isoformat()}'"
        f" ORDER BY usage_date"
    )
    loop = _asyncio.get_running_loop()
    rows = await loop.run_in_executor(None, execute_query, _sql)

    # Build daily spend lookup
    spend_by_date: dict[str, float] = {}
    for row in rows:
        d = str(row["usage_date"])[:10]
        spend_by_date[d] = float(row.get("total_spend") or 0)

    # Build cumulative series over the full contract range
    daily_series = []
    cumulative = 0.0
    day = start_date
    while day <= end_date:
        day_str = day.isoformat()
        day_index = (day - start_date).days
        ideal = (day_index / total_days) * total_commit
        if day <= query_end:
            cumulative += spend_by_date.get(day_str, 0.0)
            daily_series.append({
                "date": day_str,
                "actual_cumulative": round(cumulative, 2),
                "ideal_cumulative": round(ideal, 2),
            })
        else:
            daily_series.append({
                "date": day_str,
                "actual_cumulative": None,
                "ideal_cumulative": round(ideal, 2),
            })
        day += _td(days=1)

    spent_to_date = cumulative
    days_elapsed = max((min(today, end_date) - start_date).days, 1)
    days_remaining = max((end_date - today).days, 0)
    remaining = total_commit - spent_to_date

    # Projected end: daily burn rate projected to exhausting the commit
    avg_daily_burn = spent_to_date / days_elapsed if days_elapsed else 0
    if avg_daily_burn > 0:
        days_to_exhaust = remaining / avg_daily_burn
        projected_end = (today + _td(days=int(days_to_exhaust))).isoformat()
    else:
        projected_end = end_str

    # Pace status: ratio of actual vs ideal spend at today
    ideal_at_today = (days_elapsed / total_days) * total_commit if total_days else 0
    pace_ratio = spent_to_date / ideal_at_today if ideal_at_today > 0 else 0
    if pace_ratio < 0.95:
        pace_status = "under"
    elif pace_ratio <= 1.10:
        pace_status = "on_pace"
    else:
        pace_status = "over"

    return {
        "configured": True,
        "contract": contract,
        "kpis": {
            "total_commit_usd": total_commit,
            "spent_to_date": round(spent_to_date, 2),
            "remaining": round(remaining, 2),
            "days_elapsed": days_elapsed,
            "days_remaining": days_remaining,
            "projected_end_date": projected_end,
            "pace_status": pace_status,
        },
        "daily_series": daily_series,
    }

