"""Idempotent Lakebase schema bootstrap.

Run once after `databricks bundle deploy` to create the postgres schema and
grant the app service principal access. Safe to re-run — all statements use
IF NOT EXISTS or ON CONFLICT DO NOTHING.

Usage:
    python db/bootstrap_lakebase_schema.py
"""

import os
import sys


def _conninfo() -> str:
    import psycopg  # noqa: F401 — imported here so module loads without psycopg installed
    pghost = os.environ["PGHOST"]
    pgdb = os.environ.get("PGDATABASE", "postgres")
    pgport = os.environ.get("PGPORT", "5432")
    pgsslmode = os.environ.get("PGSSLMODE", "require")
    pguser = os.environ.get("PGUSER") or os.environ.get("DATABRICKS_CLIENT_ID", "")
    lakebase_endpoint = os.environ.get("LAKEBASE_ENDPOINT", "")
    if lakebase_endpoint:
        from databricks.sdk import WorkspaceClient
        cred = WorkspaceClient().postgres.generate_database_credential(endpoint=lakebase_endpoint)
        token = cred.token
    else:
        token = os.environ.get("DATABRICKS_TOKEN", "")
        if not token:
            from databricks.sdk import WorkspaceClient
            token = WorkspaceClient().config.oauth_token().access_token
    return (
        f"host={pghost} port={pgport} dbname={pgdb} "
        f"user={pguser} password={token} "
        f"sslmode={pgsslmode} connect_timeout=15"
    )


DDL = """
-- Schema that mirrors the Unity Catalog cost_obs schema for cached reads
CREATE SCHEMA IF NOT EXISTS cost_obs;

-- Materialized snapshot of billing.usage for the rolling 90-day window.
-- Written by the nightly refresh job; read by all dashboard queries.
CREATE TABLE IF NOT EXISTS cost_obs.usage_snapshot (
    workspace_id        TEXT,
    sku_name            TEXT,
    usage_date          DATE,
    usage_quantity      DOUBLE PRECISION,
    list_price          DOUBLE PRECISION,
    custom_price        DOUBLE PRECISION,
    usage_unit          TEXT,
    cloud               TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-cluster/warehouse daily aggregation for drill-down queries
CREATE TABLE IF NOT EXISTS cost_obs.cluster_daily (
    cluster_id          TEXT,
    cluster_name        TEXT,
    workspace_id        TEXT,
    usage_date          DATE,
    dbu                 DOUBLE PRECISION,
    list_cost           DOUBLE PRECISION,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cluster_id, usage_date)
);

-- Per-user daily DBU aggregation
CREATE TABLE IF NOT EXISTS cost_obs.user_daily (
    user_name           TEXT,
    workspace_id        TEXT,
    usage_date          DATE,
    dbu                 DOUBLE PRECISION,
    list_cost           DOUBLE PRECISION,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_name, usage_date)
);

-- Alert thresholds and state (mirrors .settings/ but in durable storage)
CREATE TABLE IF NOT EXISTS cost_obs.alert_configs (
    alert_id            TEXT PRIMARY KEY,
    metric              TEXT NOT NULL,
    threshold           DOUBLE PRECISION NOT NULL,
    window_days         INTEGER NOT NULL DEFAULT 7,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh log — written after each materialization cycle
CREATE TABLE IF NOT EXISTS cost_obs.refresh_log (
    run_id              BIGSERIAL PRIMARY KEY,
    table_name          TEXT NOT NULL,
    rows_written        INTEGER,
    duration_ms         INTEGER,
    status              TEXT NOT NULL DEFAULT 'ok',
    error_msg           TEXT,
    refreshed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for the hot query paths
CREATE INDEX IF NOT EXISTS idx_usage_snapshot_date
    ON cost_obs.usage_snapshot (usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_cluster_daily_date
    ON cost_obs.cluster_daily (usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_user_daily_date
    ON cost_obs.user_daily (usage_date DESC);

-- ── MV mirror tables (populated from Delta materialized views after each rebuild) ──

-- Mirrors daily_usage_summary Delta MV
CREATE TABLE IF NOT EXISTS cost_obs.daily_usage_summary (
    usage_date              DATE NOT NULL PRIMARY KEY,
    total_dbus              DOUBLE PRECISION,
    total_spend             DOUBLE PRECISION,
    effective_list_spend    DOUBLE PRECISION,
    workspace_count         INTEGER,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_summary_date
    ON cost_obs.daily_usage_summary (usage_date DESC);

-- Mirrors daily_product_breakdown Delta MV
CREATE TABLE IF NOT EXISTS cost_obs.daily_product_breakdown (
    usage_date              DATE NOT NULL,
    product_category        TEXT NOT NULL,
    total_dbus              DOUBLE PRECISION,
    total_spend             DOUBLE PRECISION,
    effective_list_spend    DOUBLE PRECISION,
    workspace_count         INTEGER,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (usage_date, product_category)
);
CREATE INDEX IF NOT EXISTS idx_daily_product_breakdown_date
    ON cost_obs.daily_product_breakdown (usage_date DESC);

-- Mirrors daily_workspace_breakdown Delta MV
CREATE TABLE IF NOT EXISTS cost_obs.daily_workspace_breakdown (
    usage_date              DATE NOT NULL,
    workspace_id            TEXT NOT NULL,
    workspace_name          TEXT,
    total_dbus              DOUBLE PRECISION,
    total_spend             DOUBLE PRECISION,
    effective_list_spend    DOUBLE PRECISION,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (usage_date, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_workspace_breakdown_date
    ON cost_obs.daily_workspace_breakdown (usage_date DESC);

-- Mirrors sql_tool_attribution Delta MV
CREATE TABLE IF NOT EXISTS cost_obs.sql_tool_attribution (
    usage_date                      DATE NOT NULL,
    sql_product                     TEXT NOT NULL,
    warehouse_id                    TEXT NOT NULL,
    attributed_dbus                 DOUBLE PRECISION,
    attributed_spend                DOUBLE PRECISION,
    attributed_effective_list_spend DOUBLE PRECISION,
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (usage_date, sql_product, warehouse_id)
);

-- Mirrors daily_query_stats Delta MV
CREATE TABLE IF NOT EXISTS cost_obs.daily_query_stats (
    usage_date              DATE NOT NULL PRIMARY KEY,
    total_queries           BIGINT,
    unique_query_users      BIGINT,
    total_rows_read         BIGINT,
    total_bytes_read        BIGINT,
    total_compute_seconds   DOUBLE PRECISION,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


def bootstrap() -> None:
    pghost = os.environ.get("PGHOST", "")
    if not pghost:
        print("ERROR: PGHOST not set — is the Lakebase resource bound in app.yaml?", file=sys.stderr)
        sys.exit(1)

    import psycopg
    print(f"Connecting to Lakebase at {pghost} …")
    with psycopg.connect(_conninfo(), autocommit=True) as conn:
        print("Connected. Running DDL …")
        conn.execute(DDL)
        print("Schema bootstrap complete.")


if __name__ == "__main__":
    bootstrap()
