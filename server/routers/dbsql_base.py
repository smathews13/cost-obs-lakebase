"""
Shared DBSQL Query Cost Attribution logic.

Provides a factory function to create parameterized routers for both
the original and PrPr cost-per-query materialized views. The only
difference between the two is the table name.
"""

import asyncio
import logging
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Query

from server.db import execute_query, get_catalog_schema, get_host_url

logger = logging.getLogger(__name__)


def _resolve_url(url: str | None, host: str) -> str | None:
    """Resolve MV URLs by replacing placeholders and prepending host to relative paths.

    The original MV bakes in 'https://DATABRICKS_HOST/...' as a literal string.
    The PrPr MV uses relative paths like '/sql/history?...'.
    This function normalises both to absolute URLs with the actual host.
    """
    if not url:
        return None
    # Original MV: literal placeholder
    url = url.replace("https://DATABRICKS_HOST", host)
    url = url.replace("https://databricks_host", host)
    # PrPr MV: relative paths
    if url.startswith("/") and host:
        url = f"{host}{url}"
    return url


def _build_queries(table_name: str) -> dict[str, str]:
    """Return SQL templates parameterized by table name."""
    return {
        "check_mv": f"""
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = '{{schema}}'
              AND table_name = '{table_name}'
              AND table_catalog = '{{catalog}}'
            LIMIT 1
        """,
        "data_range": f"""
            SELECT
              CAST(MIN(start_time) AS DATE) as earliest_date,
              CAST(MAX(start_time) AS DATE) as latest_date,
              COUNT(*) as total_rows
            FROM {{catalog}}.{{schema}}.{table_name}
        """,
        "by_source": f"""
            SELECT
              query_source_type,
              COUNT(*) as query_count,
              SUM(query_attributed_dollars_estimation) as total_spend,
              SUM(query_attributed_dbus_estimation) as total_dbus,
              AVG(query_attributed_dollars_estimation) as avg_cost_per_query
            FROM {{catalog}}.{{schema}}.{table_name}
            WHERE start_time >= :start_date
              AND start_time < :end_date
            GROUP BY query_source_type
            ORDER BY total_spend DESC
        """,
        "by_user": f"""
            SELECT
              executed_by,
              query_source_type,
              COUNT(*) as query_count,
              SUM(query_attributed_dollars_estimation) as total_spend,
              SUM(query_attributed_dbus_estimation) as total_dbus
            FROM {{catalog}}.{{schema}}.{table_name}
            WHERE start_time >= :start_date
              AND start_time < :end_date
            GROUP BY executed_by, query_source_type
            ORDER BY total_spend DESC
            LIMIT 100
        """,
        "top_queries": f"""
            SELECT
              statement_id,
              query_source_type,
              query_source_id,
              executed_by,
              warehouse_id,
              workspace_id,
              SUBSTRING(statement_text, 1, 200) as statement_preview,
              duration_seconds,
              query_attributed_dollars_estimation as cost,
              query_attributed_dbus_estimation as dbus,
              query_profile_url,
              url_helper as source_url,
              start_time,
              end_time
            FROM {{catalog}}.{{schema}}.{table_name}
            WHERE start_time >= :start_date
              AND start_time < :end_date
            ORDER BY query_attributed_dollars_estimation DESC
            LIMIT :limit
        """,
        "summary": f"""
            SELECT
              COUNT(*) as total_queries,
              COUNT(DISTINCT executed_by) as unique_users,
              COUNT(DISTINCT warehouse_id) as unique_warehouses,
              SUM(query_attributed_dollars_estimation) as total_spend,
              SUM(query_attributed_dbus_estimation) as total_dbus,
              AVG(query_attributed_dollars_estimation) as avg_cost_per_query,
              AVG(duration_seconds) as avg_duration_seconds
            FROM {{catalog}}.{{schema}}.{table_name}
            WHERE start_time >= :start_date
              AND start_time < :end_date
        """,
        "by_warehouse": f"""
            SELECT
              warehouse_id,
              COUNT(*) as query_count,
              COUNT(DISTINCT executed_by) as unique_users,
              SUM(query_attributed_dollars_estimation) as total_spend,
              SUM(query_attributed_dbus_estimation) as total_dbus
            FROM {{catalog}}.{{schema}}.{table_name}
            WHERE start_time >= :start_date
              AND start_time < :end_date
            GROUP BY warehouse_id
            ORDER BY total_spend DESC
            LIMIT 50
        """,
        "timeseries": f"""
            SELECT
              DATE(start_time) as date,
              query_source_type,
              COUNT(*) as query_count,
              SUM(query_attributed_dollars_estimation) as daily_spend,
              SUM(query_attributed_dbus_estimation) as daily_dbus
            FROM {{catalog}}.{{schema}}.{table_name}
            WHERE start_time >= :start_date
              AND start_time < :end_date
            GROUP BY DATE(start_time), query_source_type
            ORDER BY date
        """,
    }


def _default_dates(
    start_date: str | None, end_date: str | None
) -> tuple[str, str]:
    if not end_date:
        end_date = date.today().isoformat()
    if not start_date:
        start_date = (date.today() - timedelta(days=30)).isoformat()
    return start_date, end_date


def create_dbsql_router(table_name: str) -> APIRouter:
    """Create a DBSQL cost-attribution router for the given MV table name."""
    router = APIRouter()
    sql = _build_queries(table_name)

    def _exec(query_key: str, params: dict, catalog: str, schema: str) -> list[dict]:
        """Execute a dbsql query against Delta."""
        template = sql[query_key]
        return execute_query(template.format(catalog=catalog, schema=schema), params)

    async def check_mv_status() -> dict[str, Any]:
        catalog, schema = get_catalog_schema()

        try:
            query = sql["check_mv"].format(catalog=catalog, schema=schema)
            results = execute_query(query)
            available = len(results) > 0
        except Exception as e:
            logger.warning(f"DBSQL cost MV ({table_name}) not available: {e}")
            available = False

        data_range = {}
        if available:
            try:
                range_query = sql["data_range"].format(catalog=catalog, schema=schema)
                range_results = execute_query(range_query)
                if range_results:
                    row = range_results[0]
                    data_range = {
                        "earliest_date": str(row["earliest_date"]) if row.get("earliest_date") else None,
                        "latest_date": str(row["latest_date"]) if row.get("latest_date") else None,
                        "total_rows": int(row.get("total_rows") or 0),
                    }
            except Exception as e:
                logger.warning(f"Could not get data range for {table_name}: {e}")

        return {
            "mv_available": available,
            "catalog": catalog,
            "schema": schema,
            "table": table_name if available else None,
            "data_range": data_range,
        }

    @router.get("/status")
    async def get_status() -> dict[str, Any]:
        return await check_mv_status()

    @router.get("/summary")
    async def get_summary(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
    ) -> dict[str, Any]:
        catalog, schema = get_catalog_schema()
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {
                "available": False,
                "message": f"{table_name} MV not configured",
                "start_date": start_date,
                "end_date": end_date,
            }

        results = _exec("summary", {"start_date": start_date, "end_date": end_date}, catalog, schema)

        data_range = status.get("data_range", {})

        if not results or not (results[0].get("total_queries") or 0):
            return {
                "available": True,
                "total_queries": 0, "unique_users": 0, "unique_warehouses": 0,
                "total_spend": 0, "total_dbus": 0,
                "avg_cost_per_query": 0, "avg_duration_seconds": 0,
                "start_date": start_date, "end_date": end_date,
                "data_range": data_range,
            }

        row = results[0]
        return {
            "available": True,
            "total_queries": row.get("total_queries") or 0,
            "unique_users": row.get("unique_users") or 0,
            "unique_warehouses": row.get("unique_warehouses") or 0,
            "total_spend": float(row.get("total_spend") or 0),
            "total_dbus": float(row.get("total_dbus") or 0),
            "avg_cost_per_query": float(row.get("avg_cost_per_query") or 0),
            "avg_duration_seconds": float(row.get("avg_duration_seconds") or 0),
            "start_date": start_date,
            "end_date": end_date,
            "data_range": data_range,
        }

    @router.get("/by-source")
    async def get_by_source(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
    ) -> dict[str, Any]:
        catalog, schema = get_catalog_schema()
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {"available": False, "sources": [], "start_date": start_date, "end_date": end_date}

        results = _exec("by_source", {"start_date": start_date, "end_date": end_date}, catalog, schema)

        sources = []
        total_spend = 0
        for row in results:
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            sources.append({
                "query_source_type": row.get("query_source_type") or "Unknown",
                "query_count": row.get("query_count") or 0,
                "total_spend": spend,
                "total_dbus": float(row.get("total_dbus") or 0),
                "avg_cost_per_query": float(row.get("avg_cost_per_query") or 0),
            })

        for source in sources:
            source["percentage"] = (source["total_spend"] / total_spend * 100) if total_spend > 0 else 0

        return {"available": True, "sources": sources, "total_spend": total_spend, "start_date": start_date, "end_date": end_date}

    @router.get("/by-user")
    async def get_by_user(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
    ) -> dict[str, Any]:
        catalog, schema = get_catalog_schema()
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {"available": False, "users": [], "start_date": start_date, "end_date": end_date}

        results = _exec("by_user", {"start_date": start_date, "end_date": end_date}, catalog, schema)

        users = []
        for row in results:
            users.append({
                "executed_by": row.get("executed_by") or "Unknown",
                "query_source_type": row.get("query_source_type") or "Unknown",
                "query_count": row.get("query_count") or 0,
                "total_spend": float(row.get("total_spend") or 0),
                "total_dbus": float(row.get("total_dbus") or 0),
            })

        return {"available": True, "users": users, "start_date": start_date, "end_date": end_date}

    @router.get("/by-warehouse")
    async def get_by_warehouse(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
    ) -> dict[str, Any]:
        catalog, schema = get_catalog_schema()
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {"available": False, "warehouses": [], "start_date": start_date, "end_date": end_date}

        results = _exec("by_warehouse", {"start_date": start_date, "end_date": end_date}, catalog, schema)

        # Look up warehouse names and types from system.compute.warehouses
        warehouse_meta: dict[str, dict[str, str]] = {}
        try:
            meta_results = execute_query("""
                SELECT w.warehouse_id, MAX(w.warehouse_name) as warehouse_name,
                       MAX(w.warehouse_type) as warehouse_type, MAX(w.warehouse_size) as warehouse_size,
                       MAX(w.workspace_id) as workspace_id,
                       MAX(ws.workspace_name) as workspace_name
                FROM system.compute.warehouses w
                LEFT JOIN system.access.workspaces_latest ws ON w.workspace_id = ws.workspace_id
                GROUP BY w.warehouse_id
            """)
            for r in (meta_results or []):
                wid = r.get("warehouse_id")
                if wid:
                    warehouse_meta[wid] = {
                        "warehouse_name": r.get("warehouse_name"),
                        "warehouse_type": r.get("warehouse_type") or "CLASSIC",
                        "warehouse_size": r.get("warehouse_size") or "UNKNOWN",
                        "workspace_id": str(r.get("workspace_id")) if r.get("workspace_id") else None,
                        "workspace_name": r.get("workspace_name"),
                    }
        except Exception as e:
            logger.warning(f"Could not look up warehouse metadata: {e}")

        warehouses = []
        total_spend = 0
        for row in results:
            spend = float(row.get("total_spend") or 0)
            total_spend += spend
            wid = row.get("warehouse_id")
            meta = warehouse_meta.get(wid, {})
            warehouses.append({
                "warehouse_id": wid,
                "warehouse_name": meta.get("warehouse_name"),
                "warehouse_type": meta.get("warehouse_type"),
                "warehouse_size": meta.get("warehouse_size"),
                "workspace_id": meta.get("workspace_id"),
                "workspace_name": meta.get("workspace_name"),
                "query_count": row.get("query_count") or 0,
                "unique_users": row.get("unique_users") or 0,
                "total_spend": spend,
                "total_dbus": float(row.get("total_dbus") or 0),
            })

        for warehouse in warehouses:
            warehouse["percentage"] = (warehouse["total_spend"] / total_spend * 100) if total_spend > 0 else 0

        return {"available": True, "warehouses": warehouses, "total_spend": total_spend, "start_date": start_date, "end_date": end_date}

    @router.get("/top-queries")
    async def get_top_queries(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
        limit: int = Query(default=50, le=100),
    ) -> dict[str, Any]:
        catalog, schema = get_catalog_schema()
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {"available": False, "queries": [], "start_date": start_date, "end_date": end_date}

        results = _exec("top_queries", {"start_date": start_date, "end_date": end_date, "limit": limit}, catalog, schema)

        host = get_host_url()
        queries = []
        for row in results:
            queries.append({
                "statement_id": row.get("statement_id"),
                "query_source_type": row.get("query_source_type") or "Unknown",
                "query_source_id": row.get("query_source_id"),
                "executed_by": row.get("executed_by") or "Unknown",
                "warehouse_id": row.get("warehouse_id"),
                "workspace_id": row.get("workspace_id"),
                "statement_preview": row.get("statement_preview") or "",
                "duration_seconds": float(row.get("duration_seconds") or 0),
                "cost": float(row.get("cost") or 0),
                "dbus": float(row.get("dbus") or 0),
                "query_profile_url": _resolve_url(row.get("query_profile_url"), host),
                "source_url": _resolve_url(row.get("source_url"), host),
                "start_time": str(row.get("start_time")) if row.get("start_time") else None,
                "end_time": str(row.get("end_time")) if row.get("end_time") else None,
            })

        return {"available": True, "queries": queries, "start_date": start_date, "end_date": end_date}

    @router.get("/top-queries-by-source")
    async def get_top_queries_by_source(
        source_type: str = Query(..., description="Query source type to filter by"),
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
        limit: int = Query(default=5, le=20),
    ) -> dict[str, Any]:
        catalog, schema = get_catalog_schema()
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {"available": False, "queries": [], "start_date": start_date, "end_date": end_date}

        safe_limit = min(int(limit), 20)
        query = f"""
            SELECT
              statement_id,
              query_source_type,
              query_source_id,
              executed_by,
              warehouse_id,
              workspace_id,
              SUBSTRING(statement_text, 1, 200) as statement_preview,
              duration_seconds,
              query_attributed_dollars_estimation as cost,
              query_attributed_dbus_estimation as dbus,
              query_profile_url,
              url_helper as source_url,
              start_time,
              end_time
            FROM {catalog}.{schema}.{table_name}
            WHERE start_time >= :start_date
              AND start_time < :end_date
              AND query_source_type = :source_type
            ORDER BY query_attributed_dollars_estimation DESC
            LIMIT {safe_limit}
        """
        params = {"start_date": start_date, "end_date": end_date, "source_type": source_type}
        results = execute_query(query, params)

        host = get_host_url()
        queries = []
        for row in results:
            queries.append({
                "statement_id": row.get("statement_id"),
                "query_source_type": row.get("query_source_type") or "Unknown",
                "query_source_id": row.get("query_source_id"),
                "executed_by": row.get("executed_by") or "Unknown",
                "statement_preview": row.get("statement_preview") or "",
                "duration_seconds": float(row.get("duration_seconds") or 0),
                "cost": float(row.get("cost") or 0),
                "dbus": float(row.get("dbus") or 0),
                "query_profile_url": _resolve_url(row.get("query_profile_url"), host),
                "source_url": _resolve_url(row.get("source_url"), host),
            })

        return {"available": True, "queries": queries, "source_type": source_type, "start_date": start_date, "end_date": end_date}

    @router.get("/timeseries")
    async def get_timeseries(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
    ) -> dict[str, Any]:
        catalog, schema = get_catalog_schema()
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {"available": False, "timeseries": [], "source_types": [], "start_date": start_date, "end_date": end_date}

        results = _exec("timeseries", {"start_date": start_date, "end_date": end_date}, catalog, schema)

        data_by_date: dict[str, dict[str, Any]] = {}
        source_types_set: set[str] = set()

        for row in results:
            date_str = str(row.get("date"))
            source_type = row.get("query_source_type") or "Unknown"
            spend = float(row.get("daily_spend") or 0)

            source_types_set.add(source_type)
            if date_str not in data_by_date:
                data_by_date[date_str] = {"date": date_str}
            data_by_date[date_str][source_type] = spend

        source_types = sorted(list(source_types_set))
        timeseries = []
        for date_str in sorted(data_by_date.keys()):
            row = data_by_date[date_str]
            for st in source_types:
                if st not in row:
                    row[st] = 0
            timeseries.append(row)

        return {"available": True, "timeseries": timeseries, "source_types": source_types, "start_date": start_date, "end_date": end_date}

    @router.get("/warehouse-type-timeseries")
    async def get_warehouse_type_timeseries(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
    ) -> dict[str, Any]:
        start_date, end_date = _default_dates(start_date, end_date)

        try:
            # Get warehouse type metadata
            meta_results = execute_query("""
                SELECT warehouse_id, MAX(warehouse_type) as warehouse_type
                FROM system.compute.warehouses
                GROUP BY warehouse_id
            """)
            wh_types = {r["warehouse_id"]: r.get("warehouse_type") or "CLASSIC" for r in (meta_results or [])}
        except Exception:
            wh_types = {}

        try:
            results = execute_query("""
                SELECT
                  u.usage_date as date,
                  u.usage_metadata.warehouse_id as warehouse_id,
                  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as daily_spend
                FROM system.billing.usage u
                LEFT JOIN system.billing.list_prices p
                  ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
                WHERE u.billing_origin_product = 'SQL'
                  AND u.usage_date BETWEEN :start_date AND :end_date
                  AND u.usage_quantity > 0
                GROUP BY u.usage_date, u.usage_metadata.warehouse_id
            """, {"start_date": start_date, "end_date": end_date})
        except Exception:
            return {"available": False, "timeseries": [], "warehouse_types": []}

        # Aggregate by date + warehouse_type
        data_by_date: dict[str, dict[str, float]] = {}
        wh_type_set: set[str] = set()
        for row in (results or []):
            date_str = str(row.get("date"))
            wid = row.get("warehouse_id") or ""
            wh_type = wh_types.get(wid, "CLASSIC")
            spend = float(row.get("daily_spend") or 0)
            wh_type_set.add(wh_type)
            if date_str not in data_by_date:
                data_by_date[date_str] = {"date": date_str}
            data_by_date[date_str][wh_type] = data_by_date[date_str].get(wh_type, 0) + spend

        wh_types_list = sorted(list(wh_type_set))
        timeseries = []
        for date_str in sorted(data_by_date.keys()):
            row = data_by_date[date_str]
            for wt in wh_types_list:
                if wt not in row:
                    row[wt] = 0
            timeseries.append(row)

        return {"available": True, "timeseries": timeseries, "warehouse_types": wh_types_list}

    @router.get("/dashboard-bundle")
    async def get_dashboard_bundle(
        start_date: str = Query(default=None),
        end_date: str = Query(default=None),
    ) -> dict[str, Any]:
        start_date, end_date = _default_dates(start_date, end_date)

        status = await check_mv_status()
        if not status["mv_available"]:
            return {
                "available": False,
                "message": f"{table_name} MV not configured. See setup instructions.",
                "start_date": start_date,
                "end_date": end_date,
            }

        summary, by_source, by_user, by_warehouse, top_queries, timeseries, wh_type_ts = await asyncio.gather(
            get_summary(start_date, end_date),
            get_by_source(start_date, end_date),
            get_by_user(start_date, end_date),
            get_by_warehouse(start_date, end_date),
            get_top_queries(start_date, end_date, limit=25),
            get_timeseries(start_date, end_date),
            get_warehouse_type_timeseries(start_date, end_date),
        )

        return {
            "available": True,
            "summary": summary,
            "by_source": by_source,
            "by_user": by_user,
            "by_warehouse": by_warehouse,
            "top_queries": top_queries,
            "timeseries": timeseries,
            "warehouse_type_timeseries": wh_type_ts,
            "start_date": start_date,
            "end_date": end_date,
        }

    # Expose check_mv_status for prpr-specific endpoints
    router.check_mv_status = check_mv_status  # type: ignore[attr-defined]

    return router
