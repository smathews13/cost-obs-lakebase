"""Warehouse rightsizing and utilization recommendations.

Uses system.compute.warehouse_events, system.compute.warehouses, and
system.query.history to detect underutilized warehouses via three heuristics:
  1. IDLE_RUNNING  — warehouse running 2+ hours with no queries in 24h
  2. OVER_SCALED   — scaled to 2+ clusters but peak concurrency is low
  3. OVERSIZED     — large size with low queue wait and fast queries
"""

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter

from server.db import execute_query, execute_queries_parallel

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Tunable thresholds ────────────────────────────────────────────────────────
_IDLE_LOOKBACK_HOURS = 2
_IDLE_NO_QUERY_HOURS = 24
_OVER_SCALED_CONCURRENCY_PER_CLUSTER = 10
_OVERSIZED_MAX_QUEUE_MS = 5000
_OVERSIZED_MAX_MEDIAN_DURATION_S = 30
_OVERSIZED_MIN_QUERIES = 10
_LARGE_SIZES = ("Large", "X-Large", "2X-Large", "3X-Large", "4X-Large")

_SQL_IDLE = f"""
WITH current_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id, warehouse_type
  FROM system.compute.warehouses
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
),
recent_queries AS (
  SELECT DISTINCT compute.warehouse_id AS warehouse_id
  FROM system.query.history
  WHERE start_time >= NOW() - INTERVAL {_IDLE_NO_QUERY_HOURS} HOUR
    AND compute.warehouse_id IS NOT NULL
),
running_warehouses AS (
  SELECT DISTINCT warehouse_id
  FROM system.compute.warehouse_events
  WHERE event_time >= NOW() - INTERVAL {_IDLE_LOOKBACK_HOURS} HOUR
    AND cluster_count > 0
)
SELECT
  rw.warehouse_id,
  w.warehouse_name,
  w.warehouse_size,
  w.workspace_id,
  w.warehouse_type,
  MAX(we.event_time) AS last_event_time
FROM running_warehouses rw
JOIN current_warehouses w USING (warehouse_id)
JOIN system.compute.warehouse_events we ON we.warehouse_id = rw.warehouse_id
WHERE rw.warehouse_id NOT IN (SELECT warehouse_id FROM recent_queries)
  AND COALESCE(w.warehouse_type, 'CLASSIC') != 'SERVERLESS'
GROUP BY rw.warehouse_id, w.warehouse_name, w.warehouse_size, w.workspace_id, w.warehouse_type
"""

_SQL_OVER_SCALED = f"""
WITH current_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id
  FROM system.compute.warehouses
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
),
cluster_scale_events AS (
  SELECT
    warehouse_id,
    MAX(cluster_count) AS max_clusters_observed
  FROM system.compute.warehouse_events
  WHERE event_time >= NOW() - INTERVAL 30 DAY
  GROUP BY warehouse_id
  HAVING MAX(cluster_count) >= 2
),
concurrent_per_minute AS (
  SELECT
    compute.warehouse_id AS warehouse_id,
    DATE_TRUNC('minute', start_time) AS minute_bucket,
    COUNT(*) AS concurrent_queries
  FROM system.query.history
  WHERE start_time >= NOW() - INTERVAL 30 DAY
    AND compute.warehouse_id IS NOT NULL
  GROUP BY 1, 2
),
max_concurrency AS (
  SELECT warehouse_id, MAX(concurrent_queries) AS max_concurrent
  FROM concurrent_per_minute
  GROUP BY warehouse_id
)
SELECT
  cse.warehouse_id,
  w.warehouse_name,
  w.warehouse_size,
  w.workspace_id,
  cse.max_clusters_observed,
  COALESCE(mc.max_concurrent, 0) AS max_concurrent
FROM cluster_scale_events cse
JOIN current_warehouses w USING (warehouse_id)
LEFT JOIN max_concurrency mc USING (warehouse_id)
WHERE COALESCE(mc.max_concurrent, 0) < (cse.max_clusters_observed * {_OVER_SCALED_CONCURRENCY_PER_CLUSTER})
"""

_SQL_OVERSIZED = f"""
WITH current_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id
  FROM system.compute.warehouses
  WHERE warehouse_size IN {_LARGE_SIZES}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY warehouse_id ORDER BY change_time DESC) = 1
),
large_warehouses AS (
  SELECT warehouse_id, warehouse_name, warehouse_size, workspace_id
  FROM current_warehouses
),
qstats AS (
  SELECT
    compute.warehouse_id AS warehouse_id,
    COUNT(*) AS query_count,
    AVG(COALESCE(waiting_at_capacity_duration_ms, 0) + COALESCE(waiting_for_compute_duration_ms, 0)) AS avg_queue_ms,
    PERCENTILE_APPROX(
      UNIX_TIMESTAMP(end_time) - UNIX_TIMESTAMP(start_time), 0.5
    ) AS median_duration_seconds
  FROM system.query.history
  WHERE start_time >= NOW() - INTERVAL 30 DAY
    AND compute.warehouse_id IS NOT NULL
    AND total_task_duration_ms > 0
    AND end_time IS NOT NULL
  GROUP BY compute.warehouse_id
  HAVING COUNT(*) >= {_OVERSIZED_MIN_QUERIES}
)
SELECT
  lw.warehouse_id,
  lw.warehouse_name,
  lw.warehouse_size,
  lw.workspace_id,
  q.query_count,
  q.avg_queue_ms,
  q.median_duration_seconds
FROM large_warehouses lw
JOIN qstats q USING (warehouse_id)
WHERE q.avg_queue_ms < {_OVERSIZED_MAX_QUEUE_MS}
  AND q.median_duration_seconds < {_OVERSIZED_MAX_MEDIAN_DURATION_S}
"""


def _build_recommendation(
    row: dict, rtype: str, extra: dict | None = None
) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "warehouse_id": row.get("warehouse_id"),
        "warehouse_name": row.get("warehouse_name"),
        "warehouse_size": row.get("warehouse_size"),
        "workspace_id": str(row.get("workspace_id") or ""),
        "recommendation_type": rtype,
        **(extra or {}),
    }
    if rtype == "IDLE_RUNNING":
        rec["last_event_time"] = str(row.get("last_event_time")) if row.get("last_event_time") else None
        rec["recommendation_text"] = (
            f"Warehouse has been running for {_IDLE_LOOKBACK_HOURS}+ hours with no queries "
            f"in the last {_IDLE_NO_QUERY_HOURS}h. Consider reducing auto_stop_minutes."
        )
    elif rtype == "OVER_SCALED":
        mc = int(row.get("max_clusters_observed") or 0)
        concur = int(row.get("max_concurrent") or 0)
        rec["max_clusters_observed"] = mc
        rec["max_concurrent"] = concur
        rec["recommendation_text"] = (
            f"Warehouse scaled to {mc} clusters but peak concurrency was only {concur} queries. "
            f"Consider reducing max_num_clusters."
        )
    elif rtype == "OVERSIZED":
        q = float(row.get("avg_queue_ms") or 0)
        d = float(row.get("median_duration_seconds") or 0)
        size = row.get("warehouse_size", "")
        rec["avg_queue_ms"] = q
        rec["median_duration_seconds"] = d
        rec["query_count"] = int(row.get("query_count") or 0)
        rec["recommendation_text"] = (
            f"{size} warehouse with avg queue time {q/1000:.1f}s and median query duration {d:.1f}s. "
            f"Consider downsizing one tier."
        )
    return rec


@router.get("")
async def get_warehouse_health() -> dict[str, Any]:
    """Return rightsizing recommendations for all warehouses."""
    try:
        results = execute_queries_parallel([
            ("idle", lambda: execute_query(_SQL_IDLE)),
            ("over_scaled", lambda: execute_query(_SQL_OVER_SCALED)),
            ("oversized", lambda: execute_query(_SQL_OVERSIZED)),
        ])
    except Exception as e:
        logger.warning(f"Warehouse health queries failed: {e}")
        return {"available": False, "error": str(e), "recommendations": [], "warehouses_analyzed": 0,
                "generated_at": datetime.now(timezone.utc).isoformat()}

    recommendations: list[dict] = []
    seen_wids: set[str] = set()

    for row in (results.get("idle") or []):
        wid = row.get("warehouse_id") or ""
        recommendations.append(_build_recommendation(row, "IDLE_RUNNING"))
        seen_wids.add(wid)

    for row in (results.get("over_scaled") or []):
        recommendations.append(_build_recommendation(row, "OVER_SCALED"))
        seen_wids.add(row.get("warehouse_id") or "")

    for row in (results.get("oversized") or []):
        recommendations.append(_build_recommendation(row, "OVERSIZED"))
        seen_wids.add(row.get("warehouse_id") or "")

    # Sort: IDLE first (most actionable), then OVER_SCALED, then OVERSIZED
    order = {"IDLE_RUNNING": 0, "OVER_SCALED": 1, "OVERSIZED": 2}
    recommendations.sort(key=lambda r: order.get(r["recommendation_type"], 9))

    return {
        "available": True,
        "recommendations": recommendations,
        "warehouses_analyzed": len(seen_wids),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/{warehouse_id}")
async def get_warehouse_health_detail(warehouse_id: str) -> dict[str, Any]:
    """Return health detail for a specific warehouse."""
    result = await get_warehouse_health()
    recs = [r for r in result.get("recommendations", []) if r.get("warehouse_id") == warehouse_id]
    return {
        "available": result["available"],
        "warehouse_id": warehouse_id,
        "recommendations": recs,
        "generated_at": result.get("generated_at"),
    }
