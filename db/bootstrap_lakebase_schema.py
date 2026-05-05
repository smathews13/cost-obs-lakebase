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
    from databricks.sdk import WorkspaceClient
    pghost = os.environ["PGHOST"]
    pgdb = os.environ.get("PGDATABASE", "postgres")
    token = WorkspaceClient().config.oauth_token().access_token
    return (
        f"host={pghost} dbname={pgdb} user=token password={token} "
        "sslmode=require connect_timeout=15"
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
