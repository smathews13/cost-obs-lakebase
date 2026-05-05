"""Tagging Hub API endpoints for untagged resource discovery and tag cost attribution."""

import logging
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Query

from server.db import execute_query, execute_queries_parallel

router = APIRouter()
logger = logging.getLogger(__name__)


def get_default_start_date() -> str:
    """Get default start date (last 30 days)."""
    return (date.today() - timedelta(days=30)).isoformat()


def get_default_end_date() -> str:
    """Get default end date (today)."""
    return date.today().isoformat()


# SQL Queries for Tagging Hub

TAGGING_SUMMARY = """
WITH usage_with_tags AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.usage_quantity,
    u.usage_metadata,
    u.custom_tags,
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
  SUM(CASE WHEN has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as tagged_spend,
  SUM(CASE WHEN NOT has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as untagged_spend,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT CASE WHEN has_tags THEN workspace_id END) as tagged_workspaces,
  COUNT(DISTINCT CASE WHEN NOT has_tags THEN workspace_id END) as untagged_workspaces
FROM usage_with_tags
"""

UNTAGGED_CLUSTERS = """
SELECT
  u.usage_metadata.cluster_id AS cluster_id,
  CAST(NULL AS STRING) AS cluster_name,
  CAST(NULL AS STRING) AS cluster_source,
  CAST(NULL AS STRING) AS owner,
  MAX(u.workspace_id) as workspace_id,
  SUM(u.usage_quantity) as total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
  COUNT(DISTINCT u.usage_date) as days_active
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND p.price_end_time IS NULL
WHERE u.usage_date BETWEEN :start_date AND :end_date
  AND u.usage_quantity > 0
  AND u.usage_metadata.cluster_id IS NOT NULL
  AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
GROUP BY u.usage_metadata.cluster_id
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_CLUSTERS_ENRICHED = """
WITH cluster_info AS (
  SELECT
    cluster_id,
    MAX(cluster_name) as cluster_name,
    MAX(cluster_source) as cluster_source,
    MAX(owned_by) as owned_by
  FROM system.compute.clusters
  WHERE delete_time IS NULL
  GROUP BY cluster_id
)
SELECT
  u.usage_metadata.cluster_id AS cluster_id,
  COALESCE(ci.cluster_name, u.usage_metadata.cluster_id) AS cluster_name,
  ci.cluster_source,
  ci.owned_by as owner,
  MAX(u.workspace_id) as workspace_id,
  SUM(u.usage_quantity) as total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
  COUNT(DISTINCT u.usage_date) as days_active
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND p.price_end_time IS NULL
LEFT JOIN cluster_info ci ON u.usage_metadata.cluster_id = ci.cluster_id
WHERE u.usage_date BETWEEN :start_date AND :end_date
  AND u.usage_quantity > 0
  AND u.usage_metadata.cluster_id IS NOT NULL
  AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
GROUP BY u.usage_metadata.cluster_id, ci.cluster_name, ci.cluster_source, ci.owned_by
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_JOBS = """
WITH job_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.job_id AS job_id,
    u.usage_metadata.job_name AS job_name,
    u.sku_name,
    u.usage_quantity,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.job_id IS NOT NULL
    AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
)
SELECT
  job_id,
  MAX(job_name) as job_name,
  MAX(workspace_id) as workspace_id,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT usage_date) as days_active
FROM job_usage
GROUP BY job_id
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_JOBS_ENRICHED = """
WITH job_info AS (
  SELECT
    job_id,
    MAX(name) as job_name,
    MAX(creator_name) as creator_name
  FROM system.lakeflow.jobs
  WHERE delete_time IS NULL
  GROUP BY job_id
),
job_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.job_id AS job_id,
    u.sku_name,
    u.usage_quantity,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.job_id IS NOT NULL
    AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
)
SELECT
  ju.job_id,
  COALESCE(ji.job_name, MAX(ju.job_id)) as job_name,
  MAX(ju.workspace_id) as workspace_id,
  SUM(ju.usage_quantity) as total_dbus,
  SUM(ju.usage_quantity * ju.price_per_dbu) as total_spend,
  COUNT(DISTINCT ju.usage_date) as days_active
FROM job_usage ju
INNER JOIN job_info ji ON CAST(ju.job_id AS STRING) = CAST(ji.job_id AS STRING)
GROUP BY ju.job_id, ji.job_name
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_PIPELINES = """
SELECT
  u.usage_metadata.dlt_pipeline_id AS pipeline_id,
  CAST(NULL AS STRING) AS pipeline_name,
  MAX(u.workspace_id) as workspace_id,
  SUM(u.usage_quantity) as total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
  COUNT(DISTINCT u.usage_date) as days_active
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND p.price_end_time IS NULL
WHERE u.usage_date BETWEEN :start_date AND :end_date
  AND u.usage_quantity > 0
  AND u.usage_metadata.dlt_pipeline_id IS NOT NULL
  AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
GROUP BY u.usage_metadata.dlt_pipeline_id
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_PIPELINES_ENRICHED = """
WITH pipeline_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.dlt_pipeline_id AS pipeline_id,
    u.sku_name,
    u.usage_quantity,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.dlt_pipeline_id IS NOT NULL
    AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
),
pipeline_info AS (
  SELECT
    pipeline_id,
    MAX(name) as pipeline_name
  FROM system.lakeflow.pipelines
  WHERE delete_time IS NULL
  GROUP BY pipeline_id
)
SELECT
  pu.pipeline_id,
  pi.pipeline_name,
  MAX(pu.workspace_id) as workspace_id,
  SUM(pu.usage_quantity) as total_dbus,
  SUM(pu.usage_quantity * pu.price_per_dbu) as total_spend,
  COUNT(DISTINCT pu.usage_date) as days_active
FROM pipeline_usage pu
INNER JOIN pipeline_info pi ON pu.pipeline_id = pi.pipeline_id
GROUP BY pu.pipeline_id, pi.pipeline_name
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_WAREHOUSES = """
SELECT
  u.usage_metadata.warehouse_id AS warehouse_id,
  CAST(NULL AS STRING) AS warehouse_name,
  MAX(u.workspace_id) as workspace_id,
  SUM(u.usage_quantity) as total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
  COUNT(DISTINCT u.usage_date) as days_active
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND p.price_end_time IS NULL
WHERE u.usage_date BETWEEN :start_date AND :end_date
  AND u.usage_quantity > 0
  AND u.usage_metadata.warehouse_id IS NOT NULL
  AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
GROUP BY u.usage_metadata.warehouse_id
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_WAREHOUSES_ENRICHED = """
WITH warehouse_info AS (
  SELECT
    warehouse_id,
    MAX(warehouse_name) as warehouse_name
  FROM system.compute.warehouses
  WHERE delete_time IS NULL
  GROUP BY warehouse_id
)
SELECT
  u.usage_metadata.warehouse_id AS warehouse_id,
  COALESCE(wi.warehouse_name, u.usage_metadata.warehouse_id) AS warehouse_name,
  MAX(u.workspace_id) as workspace_id,
  SUM(u.usage_quantity) as total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
  COUNT(DISTINCT u.usage_date) as days_active
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND p.price_end_time IS NULL
LEFT JOIN warehouse_info wi ON u.usage_metadata.warehouse_id = wi.warehouse_id
WHERE u.usage_date BETWEEN :start_date AND :end_date
  AND u.usage_quantity > 0
  AND u.usage_metadata.warehouse_id IS NOT NULL
  AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
GROUP BY u.usage_metadata.warehouse_id, wi.warehouse_name
ORDER BY total_spend DESC
LIMIT 500
"""

UNTAGGED_ENDPOINTS = """
WITH endpoint_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.endpoint_name AS endpoint_name,
    u.sku_name,
    u.usage_quantity,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.endpoint_name IS NOT NULL
    AND (u.custom_tags IS NULL OR size(u.custom_tags) = 0)
)
SELECT
  endpoint_name,
  MAX(workspace_id) as workspace_id,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT usage_date) as days_active
FROM endpoint_usage
GROUP BY endpoint_name
ORDER BY total_spend DESC
LIMIT 500
"""

COST_BY_TAG = """
WITH tagged_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.usage_quantity,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.custom_tags IS NOT NULL
    AND size(u.custom_tags) > 0
),
exploded_tags AS (
  SELECT
    usage_date,
    workspace_id,
    usage_quantity,
    price_per_dbu,
    tag_key,
    tag_value
  FROM tagged_usage
  LATERAL VIEW EXPLODE(custom_tags) t AS tag_key, tag_value
)
SELECT
  tag_key,
  tag_value,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count,
  COUNT(DISTINCT usage_date) as days_active
FROM exploded_tags
GROUP BY tag_key, tag_value
ORDER BY total_spend DESC
LIMIT 500
"""

COST_BY_TAG_KEY = """
WITH tagged_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.usage_quantity,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.custom_tags IS NOT NULL
    AND size(u.custom_tags) > 0
),
exploded_tags AS (
  SELECT
    usage_date,
    workspace_id,
    usage_quantity,
    price_per_dbu,
    tag_key
  FROM tagged_usage
  LATERAL VIEW EXPLODE(custom_tags) t AS tag_key, tag_value
)
SELECT
  tag_key,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count
FROM exploded_tags
GROUP BY tag_key
ORDER BY total_spend DESC
LIMIT 50
"""

TOP_OBJECTS_BY_TAG = """
WITH tagged_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    u.custom_tags,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.custom_tags IS NOT NULL
    AND size(u.custom_tags) > 0
),
filtered AS (
  SELECT
    usage_date,
    workspace_id,
    sku_name,
    billing_origin_product,
    usage_quantity,
    usage_metadata,
    price_per_dbu
  FROM tagged_usage
  LATERAL VIEW EXPLODE(custom_tags) t AS tk, tv
  WHERE tk = :tag_key AND tv = :tag_value
),
objects AS (
  SELECT
    COALESCE(
      usage_metadata.cluster_id,
      usage_metadata.warehouse_id,
      usage_metadata.endpoint_name,
      usage_metadata.dlt_pipeline_id,
      CAST(usage_metadata.job_id AS STRING),
      sku_name
    ) as object_id,
    CASE
      WHEN usage_metadata.cluster_id IS NOT NULL THEN 'Cluster'
      WHEN usage_metadata.warehouse_id IS NOT NULL THEN 'SQL Warehouse'
      WHEN usage_metadata.endpoint_name IS NOT NULL THEN 'Serving Endpoint'
      WHEN usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'Pipeline'
      WHEN usage_metadata.job_id IS NOT NULL THEN 'Job'
      ELSE 'Other'
    END as object_type,
    COALESCE(
      usage_metadata.cluster_id,
      usage_metadata.warehouse_id,
      usage_metadata.endpoint_name,
      usage_metadata.dlt_pipeline_id,
      usage_metadata.job_name,
      sku_name
    ) as object_name,
    MAX(workspace_id) as workspace_id,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend,
    COUNT(DISTINCT usage_date) as days_active
  FROM filtered
  GROUP BY 1, 2, 3
)
SELECT * FROM objects
ORDER BY total_spend DESC
LIMIT 5
"""

AVAILABLE_TAGS = """
WITH tagged_usage AS (
  SELECT
    u.custom_tags
  FROM system.billing.usage u
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), 90)
    AND u.custom_tags IS NOT NULL
    AND size(u.custom_tags) > 0
),
exploded_tags AS (
  SELECT DISTINCT
    tag_key,
    tag_value
  FROM tagged_usage
  LATERAL VIEW EXPLODE(custom_tags) t AS tag_key, tag_value
)
SELECT
  tag_key,
  COLLECT_SET(tag_value) as tag_values
FROM exploded_tags
GROUP BY tag_key
ORDER BY tag_key
"""

TAG_COVERAGE_TIMESERIES = """
WITH usage_with_tags AS (
  SELECT
    u.usage_date,
    u.usage_quantity,
    u.custom_tags,
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
  usage_date,
  SUM(CASE WHEN has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as tagged_spend,
  SUM(CASE WHEN NOT has_tags THEN usage_quantity * price_per_dbu ELSE 0 END) as untagged_spend
FROM usage_with_tags
GROUP BY usage_date
ORDER BY usage_date
"""


@router.get("/summary")
async def get_tagging_summary(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get tagging coverage summary."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(TAGGING_SUMMARY, params)

    if not results:
        return {
            "tagged_spend": 0,
            "untagged_spend": 0,
            "total_spend": 0,
            "tagged_percentage": 0,
            "untagged_percentage": 0,
            "tagged_workspaces": 0,
            "untagged_workspaces": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    row = results[0]
    total_spend = float(row.get("total_spend") or 0)
    tagged_spend = float(row.get("tagged_spend") or 0)
    untagged_spend = float(row.get("untagged_spend") or 0)

    return {
        "tagged_spend": tagged_spend,
        "untagged_spend": untagged_spend,
        "total_spend": total_spend,
        "tagged_percentage": (tagged_spend / total_spend * 100) if total_spend > 0 else 0,
        "untagged_percentage": (untagged_spend / total_spend * 100) if total_spend > 0 else 0,
        "tagged_workspaces": row.get("tagged_workspaces") or 0,
        "untagged_workspaces": row.get("untagged_workspaces") or 0,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/untagged/clusters")
async def get_untagged_clusters(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get untagged clusters with spend."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(UNTAGGED_CLUSTERS, params)

    clusters = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        clusters.append(
            {
                "cluster_id": row.get("cluster_id"),
                "cluster_name": row.get("cluster_name"),
                "cluster_source": row.get("cluster_source"),
                "owner": row.get("owner"),
                "workspace_id": str(row.get("workspace_id")),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "days_active": row.get("days_active") or 0,
            }
        )

    return {
        "clusters": clusters,
        "total_spend": total_spend,
        "count": len(clusters),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/untagged/jobs")
async def get_untagged_jobs(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get untagged jobs with spend."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(UNTAGGED_JOBS, params)

    jobs = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        jobs.append(
            {
                "job_id": row.get("job_id"),
                "job_name": row.get("job_name"),
                "workspace_id": str(row.get("workspace_id")),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "days_active": row.get("days_active") or 0,
            }
        )

    return {
        "jobs": jobs,
        "total_spend": total_spend,
        "count": len(jobs),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/untagged/pipelines")
async def get_untagged_pipelines(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get untagged SDP pipelines with spend."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(UNTAGGED_PIPELINES, params)

    pipelines = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        pipelines.append(
            {
                "pipeline_id": row.get("pipeline_id"),
                "pipeline_name": row.get("pipeline_name"),
                "workspace_id": str(row.get("workspace_id")),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "days_active": row.get("days_active") or 0,
            }
        )

    return {
        "pipelines": pipelines,
        "total_spend": total_spend,
        "count": len(pipelines),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/untagged/warehouses")
async def get_untagged_warehouses(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get untagged SQL warehouses with spend."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(UNTAGGED_WAREHOUSES, params)

    warehouses = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        warehouses.append(
            {
                "warehouse_id": row.get("warehouse_id"),
                "warehouse_name": row.get("warehouse_name"),
                "workspace_id": str(row.get("workspace_id")),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "days_active": row.get("days_active") or 0,
            }
        )

    return {
        "warehouses": warehouses,
        "total_spend": total_spend,
        "count": len(warehouses),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/untagged/endpoints")
async def get_untagged_endpoints(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get untagged model serving endpoints with spend."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(UNTAGGED_ENDPOINTS, params)

    endpoints = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        endpoints.append(
            {
                "endpoint_name": row.get("endpoint_name"),
                "workspace_id": str(row.get("workspace_id")),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "days_active": row.get("days_active") or 0,
            }
        )

    return {
        "endpoints": endpoints,
        "total_spend": total_spend,
        "count": len(endpoints),
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/cost-by-tag")
async def get_cost_by_tag(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get cost breakdown by tag key/value pairs."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(COST_BY_TAG, params)

    tags = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        tags.append(
            {
                "tag_key": row.get("tag_key"),
                "tag_value": row.get("tag_value"),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "workspace_count": row.get("workspace_count") or 0,
                "days_active": row.get("days_active") or 0,
            }
        )

    # Calculate percentages
    for tag in tags:
        tag["percentage"] = (tag["total_spend"] / total_spend * 100) if total_spend > 0 else 0

    return {
        "tags": tags,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/top-objects-by-tag")
async def get_top_objects_by_tag(
    tag_key: str = Query(description="Tag key to drill into"),
    tag_value: str = Query(description="Tag value to drill into"),
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get top 5 most expensive objects for a specific tag key/value pair."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
        "tag_key": tag_key,
        "tag_value": tag_value,
    }

    results = execute_query(TOP_OBJECTS_BY_TAG, params)

    objects = []
    for row in results:
        objects.append(
            {
                "object_id": row.get("object_id"),
                "object_type": row.get("object_type"),
                "object_name": row.get("object_name"),
                "workspace_id": str(row.get("workspace_id")) if row.get("workspace_id") else None,
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": float(row.get("total_spend") or 0),
                "days_active": row.get("days_active") or 0,
            }
        )

    return {
        "objects": objects,
        "tag_key": tag_key,
        "tag_value": tag_value,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/cost-by-tag-key")
async def get_cost_by_tag_key(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get cost breakdown by tag key (aggregated across all values)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(COST_BY_TAG_KEY, params)

    tag_keys = []
    total_spend = 0

    for row in results:
        spend = float(row.get("total_spend") or 0)
        total_spend += spend
        tag_keys.append(
            {
                "tag_key": row.get("tag_key"),
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": spend,
                "workspace_count": row.get("workspace_count") or 0,
            }
        )

    # Calculate percentages
    for key in tag_keys:
        key["percentage"] = (key["total_spend"] / total_spend * 100) if total_spend > 0 else 0

    return {
        "tag_keys": tag_keys,
        "total_spend": total_spend,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/available-tags")
async def get_available_tags() -> dict[str, Any]:
    """Get all available tag keys and their values from the Databricks account.

    Returns tag keys with their associated values for use in tagging resources.
    """
    try:
        results = execute_query(AVAILABLE_TAGS, {})

        tags = {}
        for row in results:
            tag_key = row.get("tag_key")
            tag_values = row.get("tag_values") or []
            if tag_key:
                tags[tag_key] = sorted(tag_values)

        return {
            "tags": tags,
            "count": len(tags),
        }
    except Exception as e:
        logger.error(f"Error fetching available tags: {e}")
        return {"tags": {}, "count": 0}


@router.get("/coverage-timeseries")
async def get_tag_coverage_timeseries(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get tag coverage over time (tagged vs untagged spend)."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(TAG_COVERAGE_TIMESERIES, params)

    timeseries = []
    for row in results:
        timeseries.append(
            {
                "date": str(row.get("usage_date")),
                "Tagged": float(row.get("tagged_spend") or 0),
                "Untagged": float(row.get("untagged_spend") or 0),
            }
        )

    return {
        "timeseries": timeseries,
        "categories": ["Tagged", "Untagged"],
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


@router.get("/dashboard-bundle")
async def get_tagging_dashboard_bundle(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Get all tagging dashboard data in a single request."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    def query_with_fallback(enriched_sql: str, fallback_sql: str, query_params: dict) -> list[dict[str, Any]]:
        """Try enriched query (with system.compute tables), fall back to billing-only."""
        try:
            return execute_query(enriched_sql, query_params)
        except Exception as e:
            logger.warning(f"Enriched query failed ({e}), falling back to billing-only")
            return execute_query(fallback_sql, query_params)

    queries = [
        ("summary", lambda: execute_query(TAGGING_SUMMARY, params)),
        ("clusters", lambda: query_with_fallback(UNTAGGED_CLUSTERS_ENRICHED, UNTAGGED_CLUSTERS, params)),
        ("jobs", lambda: query_with_fallback(UNTAGGED_JOBS_ENRICHED, UNTAGGED_JOBS, params)),
        ("pipelines", lambda: query_with_fallback(UNTAGGED_PIPELINES_ENRICHED, UNTAGGED_PIPELINES, params)),
        ("warehouses", lambda: query_with_fallback(UNTAGGED_WAREHOUSES_ENRICHED, UNTAGGED_WAREHOUSES, params)),
        ("endpoints", lambda: execute_query(UNTAGGED_ENDPOINTS, params)),
        ("cost_by_tag", lambda: execute_query(COST_BY_TAG, params)),
        ("tag_keys", lambda: execute_query(COST_BY_TAG_KEY, params)),
        ("timeseries", lambda: execute_query(TAG_COVERAGE_TIMESERIES, params)),
    ]

    results = execute_queries_parallel(queries)

    # Format summary
    summary_data = results.get("summary", [])
    if summary_data:
        row = summary_data[0]
        total_spend = float(row.get("total_spend") or 0)
        tagged_spend = float(row.get("tagged_spend") or 0)
        untagged_spend = float(row.get("untagged_spend") or 0)
        summary = {
            "tagged_spend": tagged_spend,
            "untagged_spend": untagged_spend,
            "total_spend": total_spend,
            "tagged_percentage": (tagged_spend / total_spend * 100) if total_spend > 0 else 0,
            "untagged_percentage": (untagged_spend / total_spend * 100) if total_spend > 0 else 0,
        }
    else:
        summary = {"tagged_spend": 0, "untagged_spend": 0, "total_spend": 0, "tagged_percentage": 0, "untagged_percentage": 0}

    # Format untagged resources
    def format_untagged(data, key):
        items = []
        total = 0
        for row in (data or []):
            spend = float(row.get("total_spend") or 0)
            total += spend
            item = {k: row.get(k) for k in row.keys()}
            item["total_spend"] = spend
            item["total_dbus"] = float(row.get("total_dbus") or 0)
            # Ensure workspace_id is a string (may come as int from SQL)
            if "workspace_id" in item and item["workspace_id"] is not None:
                item["workspace_id"] = str(item["workspace_id"])
            items.append(item)
        return {"items": items, "total_spend": total, "count": len(items)}

    # Format tag costs
    tag_data = results.get("cost_by_tag", []) or []
    tag_total = sum(float(r.get("total_spend") or 0) for r in tag_data)
    tags = [
        {
            "tag_key": r.get("tag_key"),
            "tag_value": r.get("tag_value"),
            "total_dbus": float(r.get("total_dbus") or 0),
            "total_spend": float(r.get("total_spend") or 0),
            "percentage": (float(r.get("total_spend") or 0) / tag_total * 100) if tag_total > 0 else 0,
        }
        for r in tag_data
    ]

    # Format timeseries
    ts_data = results.get("timeseries", []) or []
    timeseries = [
        {
            "date": str(r.get("usage_date")),
            "Tagged": float(r.get("tagged_spend") or 0),
            "Untagged": float(r.get("untagged_spend") or 0),
        }
        for r in ts_data
    ]

    return {
        "summary": summary,
        "untagged": {
            "clusters": format_untagged(results.get("clusters"), "clusters"),
            "jobs": format_untagged(results.get("jobs"), "jobs"),
            "pipelines": format_untagged(results.get("pipelines"), "pipelines"),
            "warehouses": format_untagged(results.get("warehouses"), "warehouses"),
            "endpoints": format_untagged(results.get("endpoints"), "endpoints"),
        },
        "cost_by_tag": {"tags": tags, "total_spend": tag_total},
        "timeseries": {"timeseries": timeseries, "categories": ["Tagged", "Untagged"]},
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }
