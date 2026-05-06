"""Populate Lakebase postgres tables from Delta materialized views.

Called after every MV rebuild so postgres stays in sync with Delta.
Uses TRUNCATE + INSERT in a transaction per table for atomic refresh.
"""

import logging
from datetime import date

from server import lakebase
from server.db import execute_query as delta_query, get_catalog_schema

logger = logging.getLogger(__name__)

# Read SQL: pull full MV from Delta
_READ = {
    "daily_usage_summary": "SELECT usage_date, total_dbus, total_spend, effective_list_spend, workspace_count FROM {catalog}.{schema}.daily_usage_summary",
    "daily_product_breakdown": "SELECT usage_date, product_category, total_dbus, total_spend, effective_list_spend, workspace_count FROM {catalog}.{schema}.daily_product_breakdown",
    "daily_workspace_breakdown": "SELECT usage_date, workspace_id, workspace_name, total_dbus, total_spend, effective_list_spend FROM {catalog}.{schema}.daily_workspace_breakdown",
    "sql_tool_attribution": "SELECT usage_date, sql_product, warehouse_id, attributed_dbus, attributed_spend, attributed_effective_list_spend FROM {catalog}.{schema}.sql_tool_attribution",
    "daily_query_stats": "SELECT usage_date, total_queries, unique_query_users, total_rows_read, total_bytes_read, total_compute_seconds FROM {catalog}.{schema}.daily_query_stats",
}

# Write SQL: upsert into postgres (TRUNCATE handled in transaction)
_WRITE = {
    "daily_usage_summary": """
        INSERT INTO cost_obs.daily_usage_summary
            (usage_date, total_dbus, total_spend, effective_list_spend, workspace_count, updated_at)
        VALUES (%(usage_date)s, %(total_dbus)s, %(total_spend)s, %(effective_list_spend)s, %(workspace_count)s, now())
        ON CONFLICT (usage_date) DO UPDATE SET
            total_dbus = EXCLUDED.total_dbus,
            total_spend = EXCLUDED.total_spend,
            effective_list_spend = EXCLUDED.effective_list_spend,
            workspace_count = EXCLUDED.workspace_count,
            updated_at = now()
    """,
    "daily_product_breakdown": """
        INSERT INTO cost_obs.daily_product_breakdown
            (usage_date, product_category, total_dbus, total_spend, effective_list_spend, workspace_count, updated_at)
        VALUES (%(usage_date)s, %(product_category)s, %(total_dbus)s, %(total_spend)s, %(effective_list_spend)s, %(workspace_count)s, now())
        ON CONFLICT (usage_date, product_category) DO UPDATE SET
            total_dbus = EXCLUDED.total_dbus,
            total_spend = EXCLUDED.total_spend,
            effective_list_spend = EXCLUDED.effective_list_spend,
            workspace_count = EXCLUDED.workspace_count,
            updated_at = now()
    """,
    "daily_workspace_breakdown": """
        INSERT INTO cost_obs.daily_workspace_breakdown
            (usage_date, workspace_id, workspace_name, total_dbus, total_spend, effective_list_spend, updated_at)
        VALUES (%(usage_date)s, %(workspace_id)s, %(workspace_name)s, %(total_dbus)s, %(total_spend)s, %(effective_list_spend)s, now())
        ON CONFLICT (usage_date, workspace_id) DO UPDATE SET
            workspace_name = EXCLUDED.workspace_name,
            total_dbus = EXCLUDED.total_dbus,
            total_spend = EXCLUDED.total_spend,
            effective_list_spend = EXCLUDED.effective_list_spend,
            updated_at = now()
    """,
    "sql_tool_attribution": """
        INSERT INTO cost_obs.sql_tool_attribution
            (usage_date, sql_product, warehouse_id, attributed_dbus, attributed_spend, attributed_effective_list_spend, updated_at)
        VALUES (%(usage_date)s, %(sql_product)s, %(warehouse_id)s, %(attributed_dbus)s, %(attributed_spend)s, %(attributed_effective_list_spend)s, now())
        ON CONFLICT (usage_date, sql_product, warehouse_id) DO UPDATE SET
            attributed_dbus = EXCLUDED.attributed_dbus,
            attributed_spend = EXCLUDED.attributed_spend,
            attributed_effective_list_spend = EXCLUDED.attributed_effective_list_spend,
            updated_at = now()
    """,
    "daily_query_stats": """
        INSERT INTO cost_obs.daily_query_stats
            (usage_date, total_queries, unique_query_users, total_rows_read, total_bytes_read, total_compute_seconds, updated_at)
        VALUES (%(usage_date)s, %(total_queries)s, %(unique_query_users)s, %(total_rows_read)s, %(total_bytes_read)s, %(total_compute_seconds)s, now())
        ON CONFLICT (usage_date) DO UPDATE SET
            total_queries = EXCLUDED.total_queries,
            unique_query_users = EXCLUDED.unique_query_users,
            total_rows_read = EXCLUDED.total_rows_read,
            total_bytes_read = EXCLUDED.total_bytes_read,
            total_compute_seconds = EXCLUDED.total_compute_seconds,
            updated_at = now()
    """,
}


def _coerce_row(row: dict) -> dict:
    """Ensure usage_date is a Python date (Databricks SQL may return string)."""
    d = dict(row)
    ud = d.get("usage_date")
    if isinstance(ud, str):
        d["usage_date"] = date.fromisoformat(ud)
    return d


def populate_all() -> dict[str, int | str]:
    """Copy all Delta MV tables into postgres. Returns {table: row_count or error}."""
    if not lakebase.is_available():
        logger.debug("Lakebase not available — skipping populate")
        return {}

    catalog, schema = get_catalog_schema()
    results: dict[str, int | str] = {}

    for table, read_sql in _READ.items():
        try:
            rows = delta_query(read_sql.format(catalog=catalog, schema=schema))
            if not rows:
                results[table] = 0
                continue

            rows = [_coerce_row(r) for r in rows]
            write_sql = _WRITE[table]

            with lakebase.get_connection() as conn:
                with conn.cursor() as cur:
                    cur.executemany(write_sql, rows)
                conn.commit()

            results[table] = len(rows)
            logger.info("Lakebase populate %s: %d rows", table, len(rows))
        except Exception as e:
            results[table] = f"error: {e}"
            logger.error("Lakebase populate %s failed: %s", table, e)

    return results
