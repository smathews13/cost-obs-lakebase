"""SQL query templates for billing data."""

# Account info query
ACCOUNT_INFO = """
SELECT DISTINCT
  account_id,
  cloud
FROM system.billing.usage
WHERE usage_date >= CURRENT_DATE - 30
LIMIT 1
"""

# Summary query - total spend, DBUs, workspace count
BILLING_SUMMARY = """
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
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
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count,
  COUNT(DISTINCT usage_date) as days_in_range,
  MIN(usage_date) as first_date,
  MAX(usage_date) as last_date
FROM usage_with_price
"""

# By product category query (with SQL split into DBSQL vs Genie)
BILLING_BY_PRODUCT = """
WITH non_sql_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
      WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
      WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
      WHEN u.billing_origin_product = 'SERVING' OR u.billing_origin_product = 'MODEL_SERVING'
           OR u.sku_name LIKE '%SERVING%' OR u.sku_name LIKE '%INFERENCE%'
           OR u.sku_name LIKE '%PROVISIONED_THROUGHPUT%' THEN 'Model Serving'
      WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'Vector Search'
      WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
      WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
           OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
      ELSE 'Other'
    END as product_category
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.billing_origin_product != 'SQL'
),
sql_query_work AS (
  SELECT
    CASE
      WHEN client_application LIKE '%Genie%' THEN 'SQL - Genie'
      ELSE 'SQL - DBSQL'
    END AS product_category,
    DATE(start_time) AS usage_date,
    compute.warehouse_id AS warehouse_id,
    SUM(total_task_duration_ms) AS work_ms
  FROM system.query.history
  WHERE executed_as_user_id IS NOT NULL
    AND compute.warehouse_id IS NOT NULL
    -- Use partition-aware date filter for better query performance
    AND start_time >= CAST(:start_date AS TIMESTAMP)
    AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
  GROUP BY 1, 2, 3
),
sql_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.warehouse_id as warehouse_id,
    SUM(u.usage_quantity) as total_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
  GROUP BY 1, 2, 3
),
sql_attributed AS (
  SELECT
    q.product_category,
    s.workspace_id,
    CASE
      WHEN SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id) > 0
        THEN (q.work_ms / SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id)) * s.total_dbus
      ELSE 0
    END as attributed_dbus,
    CASE
      WHEN SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id) > 0
        THEN (q.work_ms / SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id)) * s.total_spend
      ELSE 0
    END as attributed_spend
  FROM sql_query_work q
  LEFT JOIN sql_usage s ON q.usage_date = s.usage_date AND q.warehouse_id = s.warehouse_id
),
non_sql_summary AS (
  SELECT
    product_category,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend,
    COUNT(DISTINCT workspace_id) as workspace_count
  FROM non_sql_usage
  GROUP BY product_category
),
sql_summary AS (
  SELECT
    product_category,
    SUM(attributed_dbus) as total_dbus,
    SUM(attributed_spend) as total_spend,
    COUNT(DISTINCT workspace_id) as workspace_count
  FROM sql_attributed
  GROUP BY product_category
)
SELECT * FROM non_sql_summary
UNION ALL
SELECT * FROM sql_summary
ORDER BY total_spend DESC
"""

# By product category query filtered by workspace
BILLING_BY_PRODUCT_WORKSPACE = """
WITH non_sql_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
      WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
      WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
      WHEN u.billing_origin_product = 'SERVING' OR u.billing_origin_product = 'MODEL_SERVING'
           OR u.sku_name LIKE '%SERVING%' OR u.sku_name LIKE '%INFERENCE%'
           OR u.sku_name LIKE '%PROVISIONED_THROUGHPUT%' THEN 'Model Serving'
      WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'Vector Search'
      WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
      WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
           OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
      ELSE 'Other'
    END as product_category
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.billing_origin_product != 'SQL'
    AND CAST(u.workspace_id AS STRING) = :workspace_id
),
sql_query_work AS (
  SELECT
    CASE
      WHEN client_application LIKE '%Genie%' THEN 'SQL - Genie'
      ELSE 'SQL - DBSQL'
    END AS product_category,
    DATE(start_time) AS usage_date,
    compute.warehouse_id AS warehouse_id,
    SUM(total_task_duration_ms) AS work_ms
  FROM system.query.history
  WHERE executed_as_user_id IS NOT NULL
    AND compute.warehouse_id IS NOT NULL
    AND start_time >= CAST(:start_date AS TIMESTAMP)
    AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
  GROUP BY 1, 2, 3
),
sql_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.warehouse_id as warehouse_id,
    SUM(u.usage_quantity) as total_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND CAST(u.workspace_id AS STRING) = :workspace_id
  GROUP BY 1, 2, 3
),
sql_attributed AS (
  SELECT
    q.product_category,
    s.workspace_id,
    CASE
      WHEN SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id) > 0
        THEN (q.work_ms / SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id)) * s.total_dbus
      ELSE 0
    END as attributed_dbus,
    CASE
      WHEN SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id) > 0
        THEN (q.work_ms / SUM(q.work_ms) OVER (PARTITION BY q.usage_date, q.warehouse_id)) * s.total_spend
      ELSE 0
    END as attributed_spend
  FROM sql_query_work q
  LEFT JOIN sql_usage s ON q.usage_date = s.usage_date AND q.warehouse_id = s.warehouse_id
),
non_sql_summary AS (
  SELECT
    product_category,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend,
    COUNT(DISTINCT workspace_id) as workspace_count
  FROM non_sql_usage
  GROUP BY product_category
),
sql_summary AS (
  SELECT
    product_category,
    SUM(attributed_dbus) as total_dbus,
    SUM(attributed_spend) as total_spend,
    COUNT(DISTINCT workspace_id) as workspace_count
  FROM sql_attributed
  GROUP BY product_category
)
SELECT * FROM non_sql_summary
UNION ALL
SELECT * FROM sql_summary
ORDER BY total_spend DESC
"""

# By workspace query (enriched with top products and top users)
BILLING_BY_WORKSPACE = """
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.identity_metadata.run_as AS run_as_user,
    u.usage_quantity,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
),
workspace_totals AS (
  SELECT
    workspace_id,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend
  FROM usage_with_price
  GROUP BY workspace_id
),
product_ranked AS (
  SELECT
    workspace_id,
    billing_origin_product,
    SUM(usage_quantity * price_per_dbu) as product_spend,
    ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY SUM(usage_quantity * price_per_dbu) DESC) as rn
  FROM usage_with_price
  WHERE billing_origin_product IS NOT NULL
  GROUP BY workspace_id, billing_origin_product
),
top_products AS (
  SELECT
    workspace_id,
    COLLECT_LIST(billing_origin_product) as products
  FROM product_ranked
  WHERE rn <= 3
  GROUP BY workspace_id
),
user_ranked AS (
  SELECT
    workspace_id,
    run_as_user,
    SUM(usage_quantity * price_per_dbu) as user_spend,
    ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY SUM(usage_quantity * price_per_dbu) DESC) as rn
  FROM usage_with_price
  WHERE run_as_user IS NOT NULL AND run_as_user != ''
  GROUP BY workspace_id, run_as_user
),
top_users AS (
  SELECT
    workspace_id,
    COLLECT_LIST(run_as_user) as users
  FROM user_ranked
  WHERE rn <= 3
  GROUP BY workspace_id
)
SELECT
  wt.workspace_id,
  ws.workspace_name,
  wt.total_dbus,
  wt.total_spend,
  tp.products as top_products,
  tu.users as top_users
FROM workspace_totals wt
LEFT JOIN top_products tp ON wt.workspace_id = tp.workspace_id
LEFT JOIN top_users tu ON wt.workspace_id = tu.workspace_id
LEFT JOIN system.access.workspaces_latest ws ON wt.workspace_id = ws.workspace_id
ORDER BY wt.total_spend DESC
"""

# Time series query (daily) with SQL split into DBSQL vs Genie
BILLING_TIMESERIES = """
WITH non_sql_usage AS (
  SELECT
    u.usage_date,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
      WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
      WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
      WHEN u.sku_name LIKE '%INFERENCE%' THEN 'Model Serving'
      ELSE 'Other'
    END as product_category
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.billing_origin_product != 'SQL'
),
sql_query_work AS (
  SELECT
    CASE
      WHEN client_application LIKE '%Genie%' THEN 'SQL - Genie'
      ELSE 'SQL - DBSQL'
    END AS product_category,
    DATE(start_time) AS usage_date,
    compute.warehouse_id AS warehouse_id,
    SUM(total_task_duration_ms) AS work_ms
  FROM system.query.history
  WHERE executed_as_user_id IS NOT NULL
    AND compute.warehouse_id IS NOT NULL
    -- Use partition-aware date filter for better query performance
    AND start_time >= CAST(:start_date AS TIMESTAMP)
    AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
  GROUP BY 1, 2, 3
),
sql_usage AS (
  SELECT
    u.usage_date,
    u.usage_metadata.warehouse_id as warehouse_id,
    SUM(u.usage_quantity) as total_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
  GROUP BY 1, 2
),
warehouse_totals AS (
  SELECT
    usage_date,
    warehouse_id,
    SUM(work_ms) as total_work_ms
  FROM sql_query_work
  GROUP BY usage_date, warehouse_id
),
sql_attributed AS (
  SELECT
    q.product_category,
    q.usage_date,
    CASE
      WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_dbus
      ELSE 0
    END as attributed_dbus,
    CASE
      WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_spend
      ELSE 0
    END as attributed_spend
  FROM sql_query_work q
  JOIN warehouse_totals w ON q.usage_date = w.usage_date AND q.warehouse_id = w.warehouse_id
  LEFT JOIN sql_usage s ON q.usage_date = s.usage_date AND q.warehouse_id = s.warehouse_id
),
non_sql_timeseries AS (
  SELECT
    usage_date,
    product_category,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * price_per_dbu) as total_spend
  FROM non_sql_usage
  GROUP BY usage_date, product_category
),
sql_timeseries AS (
  SELECT
    usage_date,
    product_category,
    SUM(attributed_dbus) as total_dbus,
    SUM(attributed_spend) as total_spend
  FROM sql_attributed
  GROUP BY usage_date, product_category
)
SELECT * FROM non_sql_timeseries
UNION ALL
SELECT * FROM sql_timeseries
ORDER BY usage_date, product_category
"""

# SQL tool attribution query (Genie vs DBSQL)
SQL_TOOL_ATTRIBUTION = """
WITH sql_query_work AS (
  SELECT
    CASE
      WHEN client_application LIKE '%Genie%' THEN 'Genie'
      ELSE 'DBSQL'
    END AS sql_product,
    DATE(start_time) AS usage_date,
    compute.warehouse_id AS warehouse_id,
    SUM(total_task_duration_ms) AS work_ms
  FROM system.query.history
  WHERE executed_as_user_id IS NOT NULL
    AND compute.warehouse_id IS NOT NULL
    -- Use partition-aware date filter for better query performance
    AND start_time >= CAST(:start_date AS TIMESTAMP)
    AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
  GROUP BY 1, 2, 3
),
sql_usage AS (
  SELECT
    u.usage_date,
    u.usage_metadata.warehouse_id as warehouse_id,
    SUM(u.usage_quantity) as total_dbus,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
  GROUP BY 1, 2
),
warehouse_totals AS (
  SELECT
    usage_date,
    warehouse_id,
    SUM(work_ms) as total_work_ms
  FROM sql_query_work
  GROUP BY usage_date, warehouse_id
),
attributed AS (
  SELECT
    q.sql_product,
    q.usage_date,
    q.warehouse_id,
    q.work_ms,
    w.total_work_ms,
    s.total_dbus,
    s.total_spend,
    CASE
      WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_dbus
      ELSE 0
    END as attributed_dbus,
    CASE
      WHEN w.total_work_ms > 0 THEN (q.work_ms / w.total_work_ms) * s.total_spend
      ELSE 0
    END as attributed_spend
  FROM sql_query_work q
  JOIN warehouse_totals w ON q.usage_date = w.usage_date AND q.warehouse_id = w.warehouse_id
  LEFT JOIN sql_usage s ON q.usage_date = s.usage_date AND q.warehouse_id = s.warehouse_id
)
SELECT
  sql_product,
  SUM(attributed_dbus) as total_dbus,
  SUM(attributed_spend) as total_spend
FROM attributed
GROUP BY sql_product
ORDER BY total_spend DESC
"""

# Pipeline objects query - enriched with pipeline names from system.lakeflow.pipelines
PIPELINE_OBJECTS_ENRICHED = """
WITH pipeline_info AS (
  SELECT
    pipeline_id,
    MAX(name) as pipeline_name,
    MAX(creator_name) as creator_name
  FROM system.lakeflow.pipelines
  WHERE delete_time IS NULL
  GROUP BY pipeline_id
),
pipeline_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.billing_origin_product,
    u.usage_metadata.dlt_pipeline_id AS pipeline_id,
    u.usage_metadata.job_id AS job_id,
    u.usage_metadata.job_run_id AS job_run_id,
    u.usage_metadata.job_name AS job_name,
    u.identity_metadata.run_as AS run_as_user,
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
    AND (u.billing_origin_product IN ('JOBS', 'DLT') OR u.usage_metadata.dlt_pipeline_id IS NOT NULL)
)
SELECT
  CASE
    WHEN pu.pipeline_id IS NOT NULL THEN 'SDP Pipeline'
    WHEN pu.job_id IS NOT NULL THEN 'Job'
    ELSE 'Unknown'
  END as object_type,
  COALESCE(pu.pipeline_id, pu.job_id) as object_id,
  CASE
    WHEN pu.pipeline_id IS NOT NULL THEN COALESCE(pi.pipeline_name, pu.pipeline_id)
    ELSE COALESCE(pu.job_name, pu.job_id)
  END as object_name,
  MAX(pu.workspace_id) as workspace_id,
  CAST(NULL AS STRING) as object_state,
  COALESCE(MAX(pi.creator_name), MAX(pu.run_as_user)) as owner,
  SUM(pu.usage_quantity) as total_dbus,
  SUM(pu.usage_quantity * pu.price_per_dbu) as total_spend,
  COUNT(DISTINCT pu.job_run_id) as total_runs
FROM pipeline_usage pu
LEFT JOIN pipeline_info pi ON pu.pipeline_id = pi.pipeline_id
WHERE pu.pipeline_id IS NOT NULL OR pu.job_id IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY total_spend DESC
LIMIT 100
"""

# Pipeline objects query - fallback (billing-only, no system.lakeflow.pipelines)
PIPELINE_OBJECTS = """
WITH pipeline_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.billing_origin_product,
    u.usage_metadata.dlt_pipeline_id AS pipeline_id,
    u.usage_metadata.job_id AS job_id,
    u.usage_metadata.job_run_id AS job_run_id,
    u.usage_metadata.job_name AS job_name,
    u.identity_metadata.run_as AS run_as_user,
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
    AND (u.billing_origin_product IN ('JOBS', 'DLT') OR u.usage_metadata.dlt_pipeline_id IS NOT NULL)
)
SELECT
  CASE
    WHEN pu.pipeline_id IS NOT NULL THEN 'SDP Pipeline'
    WHEN pu.job_id IS NOT NULL THEN 'Job'
    ELSE 'Unknown'
  END as object_type,
  COALESCE(pu.pipeline_id, pu.job_id) as object_id,
  COALESCE(pu.job_name, pu.pipeline_id, pu.job_id) as object_name,
  MAX(pu.workspace_id) as workspace_id,
  CAST(NULL AS STRING) as object_state,
  MAX(pu.run_as_user) as owner,
  SUM(pu.usage_quantity) as total_dbus,
  SUM(pu.usage_quantity * pu.price_per_dbu) as total_spend,
  COUNT(DISTINCT pu.job_run_id) as total_runs
FROM pipeline_usage pu
WHERE pu.pipeline_id IS NOT NULL OR pu.job_id IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY total_spend DESC
LIMIT 100
"""

# ETL breakdown query (Batch vs Streaming)
ETL_BREAKDOWN = """
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'Streaming (SDP)'
      WHEN u.billing_origin_product = 'JOBS' THEN 'Batch Jobs'
      ELSE NULL
    END as etl_type
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND (u.billing_origin_product IN ('JOBS', 'DLT') OR u.usage_metadata.dlt_pipeline_id IS NOT NULL)
)
SELECT
  etl_type,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend
FROM usage_with_price
WHERE etl_type IS NOT NULL
GROUP BY etl_type
ORDER BY total_spend DESC
"""

# Interactive compute breakdown query (by notebook, user, cluster)
INTERACTIVE_BREAKDOWN = """
WITH interactive_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.cluster_id AS cluster_id,
    u.usage_metadata.notebook_path AS notebook_path,
    u.usage_metadata.notebook_id AS notebook_id,
    u.identity_metadata.run_as AS run_as_user,
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
    AND u.sku_name LIKE '%ALL_PURPOSE%'
),
cluster_info AS (
  SELECT
    cluster_id,
    MAX(cluster_name) as cluster_name
  FROM system.compute.clusters
  GROUP BY cluster_id
)
SELECT
  iu.cluster_id,
  ci.cluster_name,
  iu.notebook_path,
  iu.run_as_user,
  MAX(iu.workspace_id) as workspace_id,
  CAST(NULL AS STRING) as cluster_state,
  SUM(iu.usage_quantity) as total_dbus,
  SUM(iu.usage_quantity * iu.price_per_dbu) as total_spend,
  COUNT(DISTINCT iu.usage_date) as days_active,
  COUNT(DISTINCT iu.notebook_id) as notebook_count
FROM interactive_usage iu
LEFT JOIN cluster_info ci ON iu.cluster_id = ci.cluster_id
GROUP BY iu.cluster_id, ci.cluster_name, iu.notebook_path, iu.run_as_user
ORDER BY total_spend DESC
LIMIT 100
"""

# AWS infrastructure cost estimation query
# Estimates EC2 costs based on cluster instance types and runtime
AWS_COST_ESTIMATE = """
WITH cluster_info AS (
  SELECT
    cluster_id,
    cluster_name,
    driver_node_type AS driver_instance_type,
    worker_node_type AS worker_instance_type,
    cluster_source,
    CAST(NULL AS STRING) as state
  FROM system.compute.clusters
),
cluster_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.cluster_id AS cluster_id,
    u.sku_name,
    u.usage_quantity,
    -- Estimate runtime hours from DBUs (rough approximation: 1 DBU ~ 1 hour for standard clusters)
    u.usage_quantity AS estimated_dbu_hours
  FROM system.billing.usage u
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.cluster_id IS NOT NULL
    AND u.billing_origin_product NOT IN ('SQL', 'DLT')
),
-- EC2 pricing estimates (US East, On-Demand, approximate)
instance_pricing AS (
  SELECT * FROM (VALUES
    ('i3.xlarge', 0.312),
    ('i3.2xlarge', 0.624),
    ('i3.4xlarge', 1.248),
    ('i3.8xlarge', 2.496),
    ('i3.16xlarge', 4.992),
    ('i3en.xlarge', 0.452),
    ('i3en.2xlarge', 0.904),
    ('i3en.3xlarge', 1.356),
    ('i3en.6xlarge', 2.712),
    ('i3en.12xlarge', 5.424),
    ('m5.xlarge', 0.192),
    ('m5.2xlarge', 0.384),
    ('m5.4xlarge', 0.768),
    ('m5.8xlarge', 1.536),
    ('m5.12xlarge', 2.304),
    ('m5.16xlarge', 3.072),
    ('m5.24xlarge', 4.608),
    ('m5d.xlarge', 0.226),
    ('m5d.2xlarge', 0.452),
    ('m5d.4xlarge', 0.904),
    ('m5d.8xlarge', 1.808),
    ('m5d.12xlarge', 2.712),
    ('m5d.16xlarge', 3.616),
    ('m5d.24xlarge', 5.424),
    ('m5n.xlarge', 0.238),
    ('m5n.2xlarge', 0.476),
    ('m5n.4xlarge', 0.952),
    ('m5n.8xlarge', 1.904),
    ('m5dn.xlarge', 0.272),
    ('m5dn.2xlarge', 0.544),
    ('m5dn.4xlarge', 1.088),
    ('m6i.xlarge', 0.192),
    ('m6i.2xlarge', 0.384),
    ('m6i.4xlarge', 0.768),
    ('m6i.8xlarge', 1.536),
    ('r5.xlarge', 0.252),
    ('r5.2xlarge', 0.504),
    ('r5.4xlarge', 1.008),
    ('r5.8xlarge', 2.016),
    ('r5.12xlarge', 3.024),
    ('r5d.xlarge', 0.288),
    ('r5d.2xlarge', 0.576),
    ('r5d.4xlarge', 1.152),
    ('c5.xlarge', 0.17),
    ('c5.2xlarge', 0.34),
    ('c5.4xlarge', 0.68),
    ('c5.9xlarge', 1.53),
    ('c5d.xlarge', 0.192),
    ('c5d.2xlarge', 0.384),
    ('c5d.4xlarge', 0.768),
    ('p3.2xlarge', 3.06),
    ('p3.8xlarge', 12.24),
    ('p3.16xlarge', 24.48),
    ('g4dn.xlarge', 0.526),
    ('g4dn.2xlarge', 0.752),
    ('g4dn.4xlarge', 1.204),
    ('g4dn.8xlarge', 2.176),
    ('g4dn.12xlarge', 3.912),
    ('g5.xlarge', 1.006),
    ('g5.2xlarge', 1.212),
    ('g5.4xlarge', 1.624),
    ('g5.8xlarge', 2.448),
    ('g5.12xlarge', 5.672)
  ) AS t(instance_type, hourly_cost)
),
usage_with_cluster AS (
  SELECT
    cu.usage_date,
    cu.workspace_id,
    cu.cluster_id,
    ci.cluster_name,
    ci.driver_instance_type,
    ci.worker_instance_type,
    ci.cluster_source,
    ci.state,
    cu.estimated_dbu_hours,
    COALESCE(dp.hourly_cost, 0.50) AS driver_hourly_cost,
    COALESCE(wp.hourly_cost, 0.50) AS worker_hourly_cost
  FROM cluster_usage cu
  LEFT JOIN cluster_info ci ON cu.cluster_id = ci.cluster_id
  LEFT JOIN instance_pricing dp ON ci.driver_instance_type = dp.instance_type
  LEFT JOIN instance_pricing wp ON ci.worker_instance_type = wp.instance_type
)
SELECT
  cluster_id,
  cluster_name,
  driver_instance_type,
  worker_instance_type,
  cluster_source,
  MAX(workspace_id) as workspace_id,
  MAX(state) as state,
  SUM(estimated_dbu_hours) as total_dbu_hours,
  -- Estimate: assume average 2 workers, runtime ~ DBU hours / 2
  SUM(estimated_dbu_hours * (driver_hourly_cost + worker_hourly_cost * 2) / 2) as estimated_aws_cost,
  COUNT(DISTINCT usage_date) as days_active
FROM usage_with_cluster
GROUP BY cluster_id, cluster_name, driver_instance_type, worker_instance_type, cluster_source
ORDER BY estimated_aws_cost DESC
LIMIT 100
"""

# AWS cost summary by instance type family
AWS_COST_BY_INSTANCE_TYPE = """
WITH cluster_info AS (
  SELECT
    cluster_id,
    driver_node_type AS driver_instance_type,
    worker_node_type AS worker_instance_type
  FROM system.compute.clusters
),
cluster_usage AS (
  SELECT
    u.usage_date,
    u.usage_metadata.cluster_id AS cluster_id,
    u.usage_quantity AS estimated_dbu_hours
  FROM system.billing.usage u
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.cluster_id IS NOT NULL
    AND u.billing_origin_product NOT IN ('SQL', 'DLT')
),
usage_with_types AS (
  SELECT
    cu.usage_date,
    COALESCE(
      REGEXP_EXTRACT(ci.worker_instance_type, '^([a-z0-9]+)\\.', 1),
      'unknown'
    ) as instance_family,
    cu.estimated_dbu_hours
  FROM cluster_usage cu
  LEFT JOIN cluster_info ci ON cu.cluster_id = ci.cluster_id
)
SELECT
  instance_family,
  SUM(estimated_dbu_hours) as total_dbu_hours,
  COUNT(DISTINCT usage_date) as days_active
FROM usage_with_types
GROUP BY instance_family
ORDER BY total_dbu_hours DESC
"""

# AWS cost timeseries query (daily rolling aggregate)
AWS_COST_TIMESERIES = """
WITH cluster_info AS (
  SELECT
    cluster_id,
    driver_node_type AS driver_instance_type,
    worker_node_type AS worker_instance_type
  FROM system.compute.clusters
),
cluster_usage AS (
  SELECT
    u.usage_date,
    u.usage_metadata.cluster_id AS cluster_id,
    u.usage_quantity AS estimated_dbu_hours
  FROM system.billing.usage u
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.cluster_id IS NOT NULL
    AND u.billing_origin_product NOT IN ('SQL', 'DLT')
),
instance_pricing AS (
  SELECT * FROM (VALUES
    ('i3.xlarge', 0.312), ('i3.2xlarge', 0.624), ('i3.4xlarge', 1.248), ('i3.8xlarge', 2.496),
    ('i3en.xlarge', 0.452), ('i3en.2xlarge', 0.904), ('i3en.6xlarge', 2.712),
    ('m5.xlarge', 0.192), ('m5.2xlarge', 0.384), ('m5.4xlarge', 0.768), ('m5.8xlarge', 1.536),
    ('m5d.xlarge', 0.226), ('m5d.2xlarge', 0.452), ('m5d.4xlarge', 0.904),
    ('m6i.xlarge', 0.192), ('m6i.2xlarge', 0.384), ('m6i.4xlarge', 0.768),
    ('r5.xlarge', 0.252), ('r5.2xlarge', 0.504), ('r5.4xlarge', 1.008),
    ('r5d.xlarge', 0.288), ('r5d.2xlarge', 0.576), ('r5d.4xlarge', 1.152),
    ('c5.xlarge', 0.17), ('c5.2xlarge', 0.34), ('c5.4xlarge', 0.68),
    ('c5d.xlarge', 0.192), ('c5d.2xlarge', 0.384), ('c5d.4xlarge', 0.768),
    ('g4dn.xlarge', 0.526), ('g4dn.2xlarge', 0.752), ('g4dn.4xlarge', 1.204),
    ('g5.xlarge', 1.006), ('g5.2xlarge', 1.212), ('g5.4xlarge', 1.624)
  ) AS t(instance_type, hourly_cost)
),
usage_with_cluster AS (
  SELECT
    cu.usage_date,
    cu.estimated_dbu_hours,
    COALESCE(dp.hourly_cost, 0.50) AS driver_hourly_cost,
    COALESCE(wp.hourly_cost, 0.50) AS worker_hourly_cost,
    COALESCE(REGEXP_EXTRACT(ci.worker_instance_type, '^([a-z0-9]+)\\.', 1), 'unknown') AS instance_family
  FROM cluster_usage cu
  LEFT JOIN cluster_info ci ON cu.cluster_id = ci.cluster_id
  LEFT JOIN instance_pricing dp ON ci.driver_instance_type = dp.instance_type
  LEFT JOIN instance_pricing wp ON ci.worker_instance_type = wp.instance_type
)
SELECT
  usage_date,
  instance_family,
  SUM(estimated_dbu_hours * (driver_hourly_cost + worker_hourly_cost * 2) / 2) as estimated_aws_cost
FROM usage_with_cluster
GROUP BY usage_date, instance_family
ORDER BY usage_date
"""

# SKU breakdown query
SKU_BREAKDOWN = """
SELECT
  u.sku_name as product,
  COUNT(DISTINCT u.workspace_id) as workspaces_using,
  SUM(u.usage_quantity) as total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend,
  ROUND(100.0 * SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) / SUM(SUM(u.usage_quantity * COALESCE(p.pricing.default, 0))) OVER (), 2) as percentage
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND p.price_end_time IS NULL
WHERE u.usage_date >= :start_date
  AND u.usage_date <= :end_date
  AND u.usage_quantity > 0
GROUP BY u.sku_name
ORDER BY total_spend DESC
LIMIT 100
"""

# Day-over-day spend changes (anomalies) query
SPEND_ANOMALIES = """
WITH daily_stats AS (
  SELECT
    u.usage_date,
    SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as daily_spend
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date >= :start_date
    AND u.usage_date <= :end_date
    AND u.usage_quantity > 0
  GROUP BY u.usage_date
),
with_lag AS (
  SELECT
    usage_date,
    daily_spend,
    LAG(daily_spend) OVER (ORDER BY usage_date) as prev_day_spend
  FROM daily_stats
)
SELECT
  usage_date,
  daily_spend,
  prev_day_spend,
  daily_spend - prev_day_spend as change_amount,
  ROUND(100.0 * (daily_spend - prev_day_spend) / NULLIF(prev_day_spend, 0), 2) as change_percent
FROM with_lag
WHERE prev_day_spend IS NOT NULL
  AND prev_day_spend > 0
ORDER BY ABS(change_percent) DESC
LIMIT 20
"""

# Platform KPIs query - key metrics showing platform value and accomplishments
PLATFORM_KPIS = """
WITH query_stats AS (
  SELECT
    COUNT(*) as total_queries,
    COUNT(DISTINCT COALESCE(executed_by, executed_as_user_id)) as unique_query_users,
    SUM(COALESCE(read_rows, 0)) as total_rows_read,
    SUM(COALESCE(read_bytes, 0)) as total_bytes_read,
    SUM(COALESCE(total_task_duration_ms, 0)) / 1000.0 as total_compute_seconds
  FROM system.query.history
  WHERE start_time >= CAST(:start_date AS TIMESTAMP)
    AND start_time < CAST(DATE_ADD(CAST(:end_date AS DATE), 1) AS TIMESTAMP)
),
workspace_stats AS (
  SELECT
    COUNT(DISTINCT workspace_id) as active_workspaces
  FROM system.billing.usage
  WHERE usage_date >= :start_date
    AND usage_date <= :end_date
    AND usage_quantity > 0
),
job_stats AS (
  SELECT
    COUNT(DISTINCT usage_metadata.job_id) as total_jobs,
    COUNT(*) as total_job_runs,
    COUNT(DISTINCT identity_metadata.run_as) as unique_job_owners
  FROM system.billing.usage
  WHERE usage_date >= :start_date
    AND usage_date <= :end_date
    AND usage_metadata.job_id IS NOT NULL
    AND usage_quantity > 0
),
job_run_stats AS (
  SELECT
    COUNT(*) as total_runs,
    COUNT(CASE WHEN result_state = 'SUCCEEDED' THEN 1 END) as successful_runs
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= :start_date
    AND period_start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
),
cluster_stats AS (
  SELECT
    COUNT(DISTINCT usage_metadata.cluster_id) as total_clusters
  FROM system.billing.usage
  WHERE usage_date >= :start_date
    AND usage_date <= :end_date
    AND usage_metadata.cluster_id IS NOT NULL
    AND usage_quantity > 0
),
model_serving_stats AS (
  SELECT
    COUNT(DISTINCT usage_metadata.endpoint_name) as models_served,
    SUM(usage_quantity) as total_serving_dbus
  FROM system.billing.usage
  WHERE usage_date >= :start_date
    AND usage_date <= :end_date
    AND sku_name LIKE '%INFERENCE%'
    AND usage_quantity > 0
)
SELECT
  q.total_queries,
  q.unique_query_users,
  q.total_rows_read,
  q.total_bytes_read,
  q.total_compute_seconds,
  COALESCE(j.total_jobs, 0) as total_jobs,
  COALESCE(j.total_job_runs, 0) as total_job_runs,
  COALESCE(jr.successful_runs, 0) as successful_runs,
  COALESCE(j.unique_job_owners, 0) as unique_job_owners,
  w.active_workspaces,
  COALESCE(c.total_clusters, 0) as active_notebooks,
  COALESCE(m.models_served, 0) as models_served,
  COALESCE(m.total_serving_dbus, 0) as total_serving_dbus
FROM query_stats q
CROSS JOIN workspace_stats w
LEFT JOIN job_stats j ON 1=1
LEFT JOIN job_run_stats jr ON 1=1
LEFT JOIN cluster_stats c ON 1=1
LEFT JOIN model_serving_stats m ON 1=1
"""

# =============================================================================
# FAST QUERIES - Optimized for quick initial page load
# These queries skip system.query.history joins which are very slow
# =============================================================================

# Fast by product query - combines SQL into single category (no Genie/DBSQL split)
BILLING_BY_PRODUCT_FAST = """
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'SQL' THEN 'SQL'
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
      WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
      WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
      WHEN u.billing_origin_product = 'SERVING' OR u.billing_origin_product = 'MODEL_SERVING'
           OR u.sku_name LIKE '%SERVING%' OR u.sku_name LIKE '%INFERENCE%'
           OR u.sku_name LIKE '%PROVISIONED_THROUGHPUT%' THEN 'Model Serving'
      WHEN u.sku_name LIKE '%VECTOR_SEARCH%' THEN 'Vector Search'
      WHEN u.sku_name LIKE '%FOUNDATION_MODEL%' OR u.sku_name LIKE '%FINE_TUNING%' THEN 'Fine-Tuning'
      WHEN u.sku_name LIKE '%AI_BI%' OR u.sku_name LIKE '%AI_QUERY%'
           OR u.sku_name LIKE '%AI_FUNCTIONS%' THEN 'AI Functions'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
      ELSE 'Other'
    END as product_category
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
)
SELECT
  product_category,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count
FROM usage_with_price
GROUP BY product_category
ORDER BY total_spend DESC
"""

# Fast time series query - combines SQL into single category (no Genie/DBSQL split)
BILLING_TIMESERIES_FAST = """
WITH usage_with_price AS (
  SELECT
    u.usage_date,
    u.sku_name,
    u.billing_origin_product,
    u.usage_quantity,
    u.usage_metadata,
    COALESCE(p.pricing.default, 0) as price_per_dbu,
    CASE
      WHEN u.billing_origin_product = 'SQL' THEN 'SQL'
      WHEN u.billing_origin_product = 'DLT' OR u.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'ETL - Streaming'
      WHEN u.billing_origin_product = 'JOBS' THEN 'ETL - Batch'
      WHEN u.sku_name LIKE '%ALL_PURPOSE%' THEN 'Interactive'
      WHEN u.sku_name LIKE '%SERVERLESS%' AND u.billing_origin_product NOT IN ('JOBS', 'SQL', 'DLT') THEN 'Serverless'
      WHEN u.sku_name LIKE '%INFERENCE%' THEN 'Model Serving'
      ELSE 'Other'
    END as product_category
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
  product_category,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend
FROM usage_with_price
GROUP BY usage_date, product_category
ORDER BY usage_date, product_category
"""

# Multi-cloud infrastructure cost estimation query
# Uses dynamic pricing based on cloud provider
INFRA_COST_ESTIMATE = """
WITH cluster_info AS (
  -- Deduplicate audit log — one row per cluster with latest config
  SELECT
    cluster_id,
    MAX(cluster_name)     AS cluster_name,
    MAX(driver_node_type) AS driver_instance_type,
    MAX(worker_node_type) AS worker_instance_type,
    MAX(cluster_source)   AS cluster_source
  FROM system.compute.clusters
  GROUP BY cluster_id
),
usage_with_cluster AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_metadata.cluster_id AS cluster_id,
    u.cloud,
    u.usage_quantity            AS estimated_dbu_hours,
    ci.cluster_name,
    ci.driver_instance_type,
    ci.worker_instance_type,
    ci.cluster_source
  FROM system.billing.usage u
  LEFT JOIN cluster_info ci ON u.usage_metadata.cluster_id = ci.cluster_id
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.cluster_id IS NOT NULL
    AND u.billing_origin_product NOT IN ('SQL', 'DLT')
)
SELECT
  cluster_id,
  MAX(cluster_name)            AS cluster_name,
  MAX(driver_instance_type)    AS driver_instance_type,
  MAX(worker_instance_type)    AS worker_instance_type,
  MAX(cluster_source)          AS cluster_source,
  MAX(workspace_id)            AS workspace_id,
  MAX(cloud)                   AS cloud,
  SUM(estimated_dbu_hours)     AS total_dbu_hours,
  COUNT(DISTINCT usage_date)   AS days_active
FROM usage_with_cluster
GROUP BY cluster_id
ORDER BY total_dbu_hours DESC
LIMIT 100
"""

# Derived from INFRA_COST_ESTIMATE results in Python — no separate query needed
INFRA_COST_BY_INSTANCE_TYPE = None

# Multi-cloud cost timeseries
INFRA_COST_TIMESERIES = """
WITH cluster_info AS (
  SELECT
    cluster_id,
    driver_node_type AS driver_instance_type,
    worker_node_type AS worker_instance_type
  FROM system.compute.clusters
),
cluster_usage AS (
  SELECT
    u.usage_date,
    u.usage_metadata.cluster_id AS cluster_id,
    u.cloud,
    u.usage_quantity AS estimated_dbu_hours
  FROM system.billing.usage u
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.usage_metadata.cluster_id IS NOT NULL
    AND u.billing_origin_product NOT IN ('SQL', 'DLT')
),
usage_with_cluster AS (
  SELECT
    cu.usage_date,
    cu.cloud,
    cu.estimated_dbu_hours,
    ci.driver_instance_type,
    ci.worker_instance_type
  FROM cluster_usage cu
  LEFT JOIN cluster_info ci ON cu.cluster_id = ci.cluster_id
)
SELECT
  usage_date,
  MAX(cloud) as cloud,
  SUM(estimated_dbu_hours) as total_dbu_hours
FROM usage_with_cluster
GROUP BY usage_date
ORDER BY usage_date
"""

# Fast Platform KPIs - single scan of billing.usage + separate lakeflow query
PLATFORM_KPIS_FAST = """
WITH billing_agg AS (
  SELECT
    COUNT(DISTINCT workspace_id) as active_workspaces,
    COUNT(DISTINCT CASE WHEN usage_metadata.job_id IS NOT NULL THEN usage_metadata.job_id END) as total_jobs,
    SUM(CASE WHEN usage_metadata.job_id IS NOT NULL THEN 1 ELSE 0 END) as total_job_runs,
    COUNT(DISTINCT CASE WHEN usage_metadata.job_id IS NOT NULL THEN identity_metadata.run_as END) as unique_job_owners,
    COUNT(DISTINCT usage_metadata.cluster_id) as total_clusters,
    COUNT(DISTINCT CASE WHEN billing_origin_product = 'SQL' THEN usage_metadata.warehouse_id END) as sql_warehouses,
    SUM(CASE WHEN billing_origin_product = 'SQL' THEN usage_quantity ELSE 0 END) as sql_dbus,
    COUNT(DISTINCT CASE WHEN sku_name LIKE '%INFERENCE%' THEN usage_metadata.endpoint_name END) as models_served,
    SUM(CASE WHEN sku_name LIKE '%INFERENCE%' THEN usage_quantity ELSE 0 END) as total_serving_dbus
  FROM system.billing.usage
  WHERE usage_date >= :start_date
    AND usage_date <= :end_date
    AND usage_quantity > 0
),
job_run_stats AS (
  SELECT
    COUNT(*) as total_runs,
    COUNT(CASE WHEN result_state = 'SUCCEEDED' THEN 1 END) as successful_runs
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= :start_date
    AND period_start_time < DATE_ADD(CAST(:end_date AS DATE), 1)
)
SELECT
  0 as total_queries,
  0 as unique_query_users,
  0 as total_rows_read,
  0 as total_bytes_read,
  0 as total_compute_seconds,
  COALESCE(b.total_jobs, 0) as total_jobs,
  COALESCE(b.total_job_runs, 0) as total_job_runs,
  COALESCE(jr.successful_runs, 0) as successful_runs,
  COALESCE(b.unique_job_owners, 0) as unique_job_owners,
  COALESCE(b.active_workspaces, 0) as active_workspaces,
  COALESCE(b.total_clusters, 0) as active_notebooks,
  COALESCE(b.models_served, 0) as models_served,
  COALESCE(b.total_serving_dbus, 0) as total_serving_dbus,
  COALESCE(b.sql_warehouses, 0) as sql_warehouses,
  COALESCE(b.sql_dbus, 0) as sql_dbus
FROM billing_agg b
LEFT JOIN job_run_stats jr ON 1=1
"""
