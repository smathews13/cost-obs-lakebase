"""Query origin attribution — MCP/tool vs human vs Genie vs service principal.

Classifies SQL warehouse queries by origin using query_tags, client_application,
executed_by identity, and query_source metadata from system.query.history.
"""

import logging
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Query

from server.db import execute_query, execute_queries_parallel, get_catalog_schema

router = APIRouter()
logger = logging.getLogger(__name__)


def _default_dates(
    start_date: str | None, end_date: str | None
) -> tuple[str, str]:
    if not end_date:
        end_date = date.today().isoformat()
    if not start_date:
        start_date = (date.today() - timedelta(days=30)).isoformat()
    return start_date, end_date


# Origin classification CASE expression (Delta SQL)
_ORIGIN_CASE = """
CASE
  WHEN query_tags['authoring_tool'] IS NOT NULL
       OR lower(COALESCE(query_tags['origin'], '')) = 'mcp'
       OR lower(COALESCE(client_application, '')) LIKE '%mcp%'
  THEN 'MCP_TOOL'
  WHEN query_source.genie_space_id IS NOT NULL
       OR lower(COALESCE(client_application, '')) LIKE '%genie%'
  THEN 'GENIE'
  WHEN executed_by IS NOT NULL
       AND executed_by NOT LIKE '%@%'
  THEN 'SERVICE_PRINCIPAL'
  ELSE 'HUMAN'
END
""".strip()


_SUMMARY_SQL = """
WITH classified AS (
  SELECT
    {origin_case} AS query_origin,
    COALESCE(cpq.query_attributed_dollars_estimation, 0) AS cost,
    COALESCE(cpq.query_attributed_dbus_estimation, 0)    AS dbus
  FROM system.query.history h
  LEFT JOIN {{catalog}}.{{schema}}.dbsql_cost_per_query cpq
    ON h.statement_id = cpq.statement_id
  WHERE h.start_time >= :start_date
    AND h.start_time < :end_date
    AND h.compute.warehouse_id IS NOT NULL
    AND h.total_task_duration_ms > 0
)
SELECT
  query_origin,
  COUNT(*) AS query_count,
  SUM(cost)  AS total_spend,
  SUM(dbus)  AS total_dbus
FROM classified
GROUP BY query_origin
ORDER BY total_spend DESC
""".format(origin_case=_ORIGIN_CASE)

# Fallback: no cost attribution (used when dbsql_cost_per_query MV doesn't exist yet)
_SUMMARY_SQL_NO_COST = """
SELECT
  {origin_case} AS query_origin,
  COUNT(*)       AS query_count,
  0.0            AS total_spend,
  0.0            AS total_dbus
FROM system.query.history h
WHERE h.start_time >= :start_date
  AND h.start_time < :end_date
  AND h.compute.warehouse_id IS NOT NULL
  AND h.total_task_duration_ms > 0
GROUP BY query_origin
ORDER BY query_count DESC
""".format(origin_case=_ORIGIN_CASE)


_TIMESERIES_SQL = """
WITH classified AS (
  SELECT
    DATE(h.start_time)                                   AS usage_date,
    {origin_case} AS query_origin,
    COALESCE(cpq.query_attributed_dollars_estimation, 0) AS cost,
    COALESCE(cpq.query_attributed_dbus_estimation, 0)    AS dbus
  FROM system.query.history h
  LEFT JOIN {{catalog}}.{{schema}}.dbsql_cost_per_query cpq
    ON h.statement_id = cpq.statement_id
  WHERE h.start_time >= :start_date
    AND h.start_time < :end_date
    AND h.compute.warehouse_id IS NOT NULL
    AND h.total_task_duration_ms > 0
)
SELECT
  usage_date,
  query_origin,
  COUNT(*) AS query_count,
  SUM(cost) AS daily_spend
FROM classified
GROUP BY usage_date, query_origin
ORDER BY usage_date, query_origin
""".format(origin_case=_ORIGIN_CASE)

_TIMESERIES_SQL_NO_COST = """
SELECT
  DATE(h.start_time) AS usage_date,
  {origin_case}      AS query_origin,
  COUNT(*)           AS query_count,
  0.0                AS daily_spend
FROM system.query.history h
WHERE h.start_time >= :start_date
  AND h.start_time < :end_date
  AND h.compute.warehouse_id IS NOT NULL
  AND h.total_task_duration_ms > 0
GROUP BY DATE(h.start_time), query_origin
ORDER BY usage_date, query_origin
""".format(origin_case=_ORIGIN_CASE)


_BY_WAREHOUSE_SQL = """
WITH classified AS (
  SELECT
    h.compute.warehouse_id                               AS warehouse_id,
    {origin_case} AS query_origin,
    COALESCE(cpq.query_attributed_dollars_estimation, 0) AS cost,
    COALESCE(cpq.query_attributed_dbus_estimation, 0)    AS dbus
  FROM system.query.history h
  LEFT JOIN {{catalog}}.{{schema}}.dbsql_cost_per_query cpq
    ON h.statement_id = cpq.statement_id
  WHERE h.start_time >= :start_date
    AND h.start_time < :end_date
    AND h.compute.warehouse_id IS NOT NULL
    AND h.total_task_duration_ms > 0
)
SELECT
  warehouse_id,
  query_origin,
  COUNT(*) AS query_count,
  SUM(cost) AS total_spend,
  SUM(dbus) AS total_dbus
FROM classified
GROUP BY warehouse_id, query_origin
ORDER BY total_spend DESC
""".format(origin_case=_ORIGIN_CASE)

_BY_WAREHOUSE_SQL_NO_COST = """
SELECT
  h.compute.warehouse_id AS warehouse_id,
  {origin_case}          AS query_origin,
  COUNT(*)               AS query_count,
  0.0                    AS total_spend,
  0.0                    AS total_dbus
FROM system.query.history h
WHERE h.start_time >= :start_date
  AND h.start_time < :end_date
  AND h.compute.warehouse_id IS NOT NULL
  AND h.total_task_duration_ms > 0
GROUP BY h.compute.warehouse_id, query_origin
ORDER BY query_count DESC
""".format(origin_case=_ORIGIN_CASE)


_TOP_QUERIES_SQL = """
SELECT
  h.statement_id,
  COALESCE(h.executed_by, h.executed_as_user_id) AS executed_by,
  h.client_application,
  h.query_tags,
  h.compute.warehouse_id                           AS warehouse_id,
  h.start_time,
  (UNIX_TIMESTAMP(h.end_time) - UNIX_TIMESTAMP(h.start_time)) AS duration_seconds,
  COALESCE(cpq.query_attributed_dollars_estimation, 0) AS cost,
  COALESCE(cpq.query_attributed_dbus_estimation, 0)    AS dbus,
  cpq.query_profile_url,
  {origin_case} AS query_origin,
  h.query_tags['authoring_tool'] AS authoring_tool
FROM system.query.history h
LEFT JOIN {{catalog}}.{{schema}}.dbsql_cost_per_query cpq
  ON h.statement_id = cpq.statement_id
WHERE h.start_time >= :start_date
  AND h.start_time < :end_date
  AND h.compute.warehouse_id IS NOT NULL
  AND h.total_task_duration_ms > 0
  AND ({origin_case}) = :origin
ORDER BY cost DESC
LIMIT :limit
""".format(origin_case=_ORIGIN_CASE)

_TOP_QUERIES_SQL_NO_COST = """
SELECT
  h.statement_id,
  COALESCE(h.executed_by, h.executed_as_user_id) AS executed_by,
  h.client_application,
  h.query_tags,
  h.compute.warehouse_id                           AS warehouse_id,
  h.start_time,
  (UNIX_TIMESTAMP(h.end_time) - UNIX_TIMESTAMP(h.start_time)) AS duration_seconds,
  0.0  AS cost,
  0.0  AS dbus,
  NULL AS query_profile_url,
  {origin_case} AS query_origin,
  h.query_tags['authoring_tool'] AS authoring_tool
FROM system.query.history h
WHERE h.start_time >= :start_date
  AND h.start_time < :end_date
  AND h.compute.warehouse_id IS NOT NULL
  AND h.total_task_duration_ms > 0
  AND ({origin_case}) = :origin
ORDER BY duration_seconds DESC
LIMIT :limit
""".format(origin_case=_ORIGIN_CASE)


def _execute_with_fallback(
    sql_with_cost: str,
    sql_no_cost: str,
    params: dict,
) -> tuple[list, bool]:
    """Try the cost-enriched query; fall back to no-cost version on any failure."""
    try:
        rows = execute_query(sql_with_cost, params)
        return rows, True
    except Exception as e:
        logger.info(f"Cost query failed, trying no-cost fallback: {str(e)[:200]}")
        rows = execute_query(sql_no_cost, params)
        return rows, False


@router.get("/summary")
async def get_origin_summary(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    start_date, end_date = _default_dates(start_date, end_date)
    catalog, schema = get_catalog_schema()
    try:
        rows, has_cost = _execute_with_fallback(
            _SUMMARY_SQL.format(catalog=catalog, schema=schema),
            _SUMMARY_SQL_NO_COST,
            {"start_date": start_date, "end_date": end_date},
        )
    except Exception as e:
        logger.warning(f"Query origin summary failed: {e}")
        return {"available": False, "origins": [], "total_spend": 0,
                "start_date": start_date, "end_date": end_date}

    total_spend = sum(float(r.get("total_spend") or 0) for r in rows)
    total_queries = sum(int(r.get("query_count") or 0) for r in rows)
    origins = [
        {
            "origin": r.get("query_origin") or "HUMAN",
            "query_count": int(r.get("query_count") or 0),
            "total_spend": float(r.get("total_spend") or 0),
            "total_dbus": float(r.get("total_dbus") or 0),
            "percentage": round(float(r.get("query_count") or 0) / total_queries * 100, 2)
            if not has_cost and total_queries > 0
            else (round(float(r.get("total_spend") or 0) / total_spend * 100, 2) if total_spend > 0 else 0),
        }
        for r in rows
    ]
    return {"available": True, "has_cost_data": has_cost, "origins": origins,
            "total_spend": total_spend, "start_date": start_date, "end_date": end_date}


@router.get("/timeseries")
async def get_origin_timeseries(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    start_date, end_date = _default_dates(start_date, end_date)
    catalog, schema = get_catalog_schema()
    try:
        rows, _ = _execute_with_fallback(
            _TIMESERIES_SQL.format(catalog=catalog, schema=schema),
            _TIMESERIES_SQL_NO_COST,
            {"start_date": start_date, "end_date": end_date},
        )
    except Exception as e:
        logger.warning(f"Query origin timeseries failed: {e}")
        return {"available": False, "timeseries": [], "origins": [],
                "start_date": start_date, "end_date": end_date}

    origins_set: set[str] = set()
    data_by_date: dict[str, dict] = {}
    for r in rows:
        d = str(r.get("usage_date"))
        origin = r.get("query_origin") or "HUMAN"
        origins_set.add(origin)
        if d not in data_by_date:
            data_by_date[d] = {"date": d}
        data_by_date[d][origin] = float(r.get("daily_spend") or 0)

    origins = sorted(list(origins_set))
    timeseries = []
    for d in sorted(data_by_date):
        row = data_by_date[d]
        for o in origins:
            if o not in row:
                row[o] = 0
        timeseries.append(row)

    return {"available": True, "timeseries": timeseries, "origins": origins,
            "start_date": start_date, "end_date": end_date}


@router.get("/by-warehouse")
async def get_origin_by_warehouse(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    start_date, end_date = _default_dates(start_date, end_date)
    catalog, schema = get_catalog_schema()
    try:
        rows, _ = _execute_with_fallback(
            _BY_WAREHOUSE_SQL.format(catalog=catalog, schema=schema),
            _BY_WAREHOUSE_SQL_NO_COST,
            {"start_date": start_date, "end_date": end_date},
        )
    except Exception as e:
        logger.warning(f"Query origin by-warehouse failed: {e}")
        return {"available": False, "warehouses": [], "start_date": start_date, "end_date": end_date}

    wh_map: dict[str, dict] = {}
    for r in rows:
        wid = r.get("warehouse_id") or "unknown"
        if wid not in wh_map:
            wh_map[wid] = {"warehouse_id": wid, "total_spend": 0, "total_dbus": 0, "origins": {}}
        origin = r.get("query_origin") or "HUMAN"
        spend = float(r.get("total_spend") or 0)
        wh_map[wid]["total_spend"] += spend
        wh_map[wid]["total_dbus"] += float(r.get("total_dbus") or 0)
        wh_map[wid]["origins"][origin] = {
            "query_count": int(r.get("query_count") or 0),
            "total_spend": spend,
        }

    warehouses = sorted(wh_map.values(), key=lambda x: x["total_spend"], reverse=True)
    return {"available": True, "warehouses": warehouses,
            "start_date": start_date, "end_date": end_date}


@router.get("/top-queries")
async def get_top_queries_by_origin(
    origin: str = Query(default="MCP_TOOL"),
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    limit: int = Query(default=20, le=100),
) -> dict[str, Any]:
    start_date, end_date = _default_dates(start_date, end_date)
    catalog, schema = get_catalog_schema()
    safe_limit = min(int(limit), 100)
    try:
        sql_cost = _TOP_QUERIES_SQL.format(catalog=catalog, schema=schema).replace("LIMIT :limit", f"LIMIT {safe_limit}")
        sql_no_cost = _TOP_QUERIES_SQL_NO_COST.replace("LIMIT :limit", f"LIMIT {safe_limit}")
        rows, _ = _execute_with_fallback(
            sql_cost,
            sql_no_cost,
            {"start_date": start_date, "end_date": end_date, "origin": origin},
        )
    except Exception as e:
        logger.warning(f"Query origin top-queries failed: {e}")
        return {"available": False, "queries": [], "origin": origin,
                "start_date": start_date, "end_date": end_date}

    queries = [
        {
            "statement_id": r.get("statement_id"),
            "executed_by": r.get("executed_by") or "unknown",
            "client_application": r.get("client_application"),
            "warehouse_id": r.get("warehouse_id"),
            "start_time": str(r.get("start_time")) if r.get("start_time") else None,
            "duration_seconds": float(r.get("duration_seconds") or 0),
            "cost": float(r.get("cost") or 0),
            "dbus": float(r.get("dbus") or 0),
            "query_origin": r.get("query_origin"),
            "authoring_tool": r.get("authoring_tool"),
            "query_profile_url": r.get("query_profile_url"),
        }
        for r in rows
    ]
    return {"available": True, "queries": queries, "origin": origin,
            "start_date": start_date, "end_date": end_date}


@router.get("/bundle")
async def get_origin_bundle(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Run all query origin data fetches in parallel — single round-trip for the SQL Origin tab."""
    start_date, end_date = _default_dates(start_date, end_date)
    catalog, schema = get_catalog_schema()
    params = {"start_date": start_date, "end_date": end_date}

    def _run_summary():
        try:
            rows, has_cost = _execute_with_fallback(
                _SUMMARY_SQL.format(catalog=catalog, schema=schema),
                _SUMMARY_SQL_NO_COST,
                params,
            )
            return rows, has_cost
        except Exception as e:
            logger.warning(f"Bundle summary failed: {e}")
            return [], False

    def _run_timeseries():
        try:
            rows, _ = _execute_with_fallback(
                _TIMESERIES_SQL.format(catalog=catalog, schema=schema),
                _TIMESERIES_SQL_NO_COST,
                params,
            )
            return rows
        except Exception as e:
            logger.warning(f"Bundle timeseries failed: {e}")
            return []

    def _run_by_warehouse():
        try:
            rows, _ = _execute_with_fallback(
                _BY_WAREHOUSE_SQL.format(catalog=catalog, schema=schema),
                _BY_WAREHOUSE_SQL_NO_COST,
                params,
            )
            return rows
        except Exception as e:
            logger.warning(f"Bundle by-warehouse failed: {e}")
            return []

    raw = execute_queries_parallel([
        ("summary", _run_summary),
        ("timeseries", _run_timeseries),
        ("by_warehouse", _run_by_warehouse),
    ])

    # --- Format summary ---
    summary_rows, has_cost = raw.get("summary") or ([], False)
    total_spend = sum(float(r.get("total_spend") or 0) for r in summary_rows)
    total_queries = sum(int(r.get("query_count") or 0) for r in summary_rows)
    origins_summary = [
        {
            "origin": r.get("query_origin") or "HUMAN",
            "query_count": int(r.get("query_count") or 0),
            "total_spend": float(r.get("total_spend") or 0),
            "total_dbus": float(r.get("total_dbus") or 0),
            "percentage": round(float(r.get("query_count") or 0) / total_queries * 100, 2)
            if not has_cost and total_queries > 0
            else (round(float(r.get("total_spend") or 0) / total_spend * 100, 2) if total_spend > 0 else 0),
        }
        for r in summary_rows
    ]

    # --- Format timeseries ---
    ts_rows = raw.get("timeseries") or []
    origins_set: set[str] = set()
    data_by_date: dict[str, dict] = {}
    for r in ts_rows:
        d = str(r.get("usage_date"))
        origin = r.get("query_origin") or "HUMAN"
        origins_set.add(origin)
        if d not in data_by_date:
            data_by_date[d] = {"date": d}
        data_by_date[d][origin] = float(r.get("daily_spend") or 0)
    origins_list = sorted(list(origins_set))
    timeseries = []
    for d in sorted(data_by_date):
        row = data_by_date[d]
        for o in origins_list:
            if o not in row:
                row[o] = 0
        timeseries.append(row)

    # --- Format by-warehouse ---
    wh_rows = raw.get("by_warehouse") or []
    wh_map: dict[str, dict] = {}
    for r in wh_rows:
        wid = r.get("warehouse_id") or "unknown"
        if wid not in wh_map:
            wh_map[wid] = {"warehouse_id": wid, "total_spend": 0, "total_dbus": 0, "origins": {}}
        origin = r.get("query_origin") or "HUMAN"
        spend = float(r.get("total_spend") or 0)
        wh_map[wid]["total_spend"] += spend
        wh_map[wid]["total_dbus"] += float(r.get("total_dbus") or 0)
        wh_map[wid]["origins"][origin] = {
            "query_count": int(r.get("query_count") or 0),
            "total_spend": spend,
        }
    warehouses = sorted(wh_map.values(), key=lambda x: x["total_spend"], reverse=True)

    return {
        "available": True,
        "has_cost_data": has_cost,
        "summary": {"origins": origins_summary, "total_spend": total_spend},
        "timeseries": {"timeseries": timeseries, "origins": origins_list},
        "by_warehouse": {"warehouses": warehouses},
        "start_date": start_date,
        "end_date": end_date,
    }
