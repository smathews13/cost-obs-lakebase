"""Populate Lakebase Postgres tables directly from system tables (OLTP mode).

In OLTP mode there are no Delta materialized views. This module runs the same
aggregation SQL directly against system.billing / system.query via the SQL
warehouse and writes results straight into the Lakebase Postgres cost_obs schema.

Called from server/app.py _run_mv_refresh when lakebase.is_available().
"""

import logging
from datetime import date

from server import lakebase
from server.db import execute_query as delta_query
from server.lakebase_populate import _WRITE, _coerce_row

logger = logging.getLogger(__name__)

_SELECT: dict[str, str] = {
    "daily_usage_summary": """
WITH usage_with_price AS (
  SELECT
    u.usage_date, u.workspace_id, u.sku_name, u.billing_origin_product,
    u.usage_quantity,
    COALESCE(p.pricing.default, 0) AS price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) AS effective_price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {lookback_days}) AND u.usage_quantity > 0
)
SELECT usage_date,
  SUM(usage_quantity) AS total_dbus,
  SUM(usage_quantity * price_per_dbu) AS total_spend,
  SUM(usage_quantity * effective_price_per_dbu) AS effective_list_spend,
  COUNT(DISTINCT workspace_id) AS workspace_count
FROM usage_with_price
GROUP BY usage_date
ORDER BY usage_date
""",
    "daily_product_breakdown": """
WITH usage_with_price AS (
  SELECT
    u.usage_date, u.workspace_id, u.sku_name, u.billing_origin_product,
    u.usage_quantity, u.usage_metadata,
    COALESCE(p.pricing.default, 0) AS price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) AS effective_price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'SQL' THEN 'SQL'
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
      WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
      WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
      WHEN u.billing_origin_product IN ('SERVING','MODEL_SERVING')
           OR u.sku_name LIKE '%SERVING%' OR u.sku_name LIKE '%INFERENCE%'
           OR u.sku_name LIKE '%PROVISIONED_THROUGHPUT%' THEN 'Model Serving'
      WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'Vector Search'
      WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
      WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
           OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS','SQL','DLT') THEN 'Serverless'
      ELSE 'Other'
    END AS product_category
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {lookback_days}) AND u.usage_quantity > 0
)
SELECT usage_date, product_category,
  SUM(usage_quantity) AS total_dbus,
  SUM(usage_quantity * price_per_dbu) AS total_spend,
  SUM(usage_quantity * effective_price_per_dbu) AS effective_list_spend,
  COUNT(DISTINCT workspace_id) AS workspace_count
FROM usage_with_price
GROUP BY usage_date, product_category
ORDER BY usage_date, product_category
""",
    "daily_workspace_breakdown": """
WITH usage_with_price AS (
  SELECT
    u.usage_date, u.workspace_id, u.sku_name, u.usage_quantity,
    COALESCE(p.pricing.default, 0) AS price_per_dbu,
    COALESCE(p.pricing.effective_list.default, p.pricing.default, 0) AS effective_price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
  WHERE u.usage_date >= DATE_SUB(CURRENT_DATE(), {lookback_days}) AND u.usage_quantity > 0
)
SELECT uwp.usage_date, uwp.workspace_id, ws.workspace_name,
  SUM(uwp.usage_quantity) AS total_dbus,
  SUM(uwp.usage_quantity * uwp.price_per_dbu) AS total_spend,
  SUM(uwp.usage_quantity * uwp.effective_price_per_dbu) AS effective_list_spend
FROM usage_with_price uwp
LEFT JOIN system.access.workspaces_latest ws ON uwp.workspace_id = ws.workspace_id
GROUP BY uwp.usage_date, uwp.workspace_id, ws.workspace_name
ORDER BY uwp.usage_date, uwp.workspace_id
""",
    "sql_tool_attribution": """
WITH sql_query_work AS (
  SELECT
    CASE WHEN client_application LIKE '%Genie%' THEN 'Genie' ELSE 'DBSQL' END AS sql_product,
    DATE(start_time) AS usage_date,
    compute.warehouse_id AS warehouse_id,
    SUM(total_task_duration_ms) AS work_ms
  FROM system.query.history
  WHERE executed_as_user_id IS NOT NULL
    AND compute.warehouse_id IS NOT NULL
    AND DATE(start_time) >= DATE_SUB(CURRENT_DATE(), {lookback_days})
  GROUP BY 1, 2, 3
),
sql_usage AS (
  SELECT u.usage_date, u.usage_metadata.warehouse_id AS warehouse_id,
    SUM(u.usage_quantity) AS total_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) AS total_spend,
    SUM(u.usage_quantity * COALESCE(p.pricing.effective_list.default, p.pricing.default, 0)) AS effective_list_spend
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name AND u.cloud = p.cloud AND p.price_end_time IS NULL
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_date >= DATE_SUB(CURRENT_DATE(), {lookback_days}) AND u.usage_quantity > 0
  GROUP BY 1, 2
),
warehouse_totals AS (
  SELECT usage_date, warehouse_id, SUM(work_ms) AS total_work_ms
  FROM sql_query_work GROUP BY usage_date, warehouse_id
)
SELECT q.sql_product, q.usage_date, q.warehouse_id,
  CASE WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_dbus ELSE 0 END AS attributed_dbus,
  CASE WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_spend ELSE 0 END AS attributed_spend,
  CASE WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.effective_list_spend ELSE 0 END AS attributed_effective_list_spend
FROM sql_query_work q
JOIN warehouse_totals w ON q.usage_date = w.usage_date AND q.warehouse_id = w.warehouse_id
LEFT JOIN sql_usage s ON q.usage_date = s.usage_date AND q.warehouse_id = s.warehouse_id
""",
    "daily_query_stats": """
SELECT
  DATE(start_time) AS usage_date,
  COUNT(*) AS total_queries,
  COUNT(DISTINCT COALESCE(executed_by, executed_as_user_id)) AS unique_query_users,
  SUM(COALESCE(read_rows, 0)) AS total_rows_read,
  SUM(COALESCE(read_bytes, 0)) AS total_bytes_read,
  SUM(COALESCE(total_task_duration_ms, 0)) / 1000.0 AS total_compute_seconds
FROM system.query.history
WHERE DATE(start_time) >= DATE_SUB(CURRENT_DATE(), {lookback_days})
GROUP BY DATE(start_time)
ORDER BY usage_date
""",
}


def populate_all_from_source(lookback_days: int = 730) -> dict[str, int | str]:
    """Run aggregation queries against system tables and write results to Lakebase Postgres."""
    if not lakebase.is_available():
        logger.warning("Lakebase not available — skipping populate_from_source")
        return {}

    results: dict[str, int | str] = {}

    for table, select_sql in _SELECT.items():
        try:
            sql = select_sql.format(lookback_days=lookback_days)
            rows = delta_query(sql)
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
            logger.info("Lakebase populate_from_source %s: %d rows", table, len(rows))
        except Exception as e:
            results[table] = f"error: {e}"
            logger.error("Lakebase populate_from_source %s failed: %s", table, e)

    return results
