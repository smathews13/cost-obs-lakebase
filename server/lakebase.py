"""Lakebase (Postgres) connection layer.

Provides a psycopg3 connection pool that authenticates via Databricks OAuth
(no static passwords). Each new connection calls WorkspaceClient to get a
fresh short-lived token.

The app reads PGHOST / PGDATABASE from env vars injected by Databricks Apps
via the lakebase-db resource binding in app.yaml. If PGHOST is absent the
module degrades gracefully so the app still starts without Lakebase configured.
"""

import logging
import os
from contextlib import contextmanager
from typing import Generator

logger = logging.getLogger(__name__)

_pool = None  # psycopg_pool.ConnectionPool, lazy-initialized


def is_available() -> bool:
    """Return True when a Lakebase endpoint is configured."""
    return bool(os.environ.get("PGHOST"))


def _make_conninfo() -> str:
    """Build a fresh conninfo string for each new pool connection.

    Auth pattern (Databricks Apps + Lakebase declarative bundle):
    - PGHOST / PGDATABASE / PGPORT / PGSSLMODE / PGUSER are injected automatically
      by the Apps runtime when the lakebase-db postgres resource is bound.
    - PGUSER == app SP client_id, which is the Postgres role Databricks creates.
    - Password: call generate_database_credential(endpoint=LAKEBASE_ENDPOINT) for a
      fresh short-lived token.  LAKEBASE_ENDPOINT is populated via valueFrom in
      app.yaml and resolves to the endpoint path injected by the resource binding.
    - Fallback (non-bundle / local dev): use DATABRICKS_TOKEN (app SP bearer token).
    """
    pghost = os.environ.get("PGHOST", "")
    pgdatabase = os.environ.get("PGDATABASE", "postgres")
    pgport = os.environ.get("PGPORT", "5432")
    pgsslmode = os.environ.get("PGSSLMODE", "require")
    pguser = os.environ.get("PGUSER") or os.environ.get("DATABRICKS_CLIENT_ID", "")

    lakebase_endpoint = os.environ.get("LAKEBASE_ENDPOINT", "")
    if lakebase_endpoint:
        from databricks.sdk import WorkspaceClient
        cred = WorkspaceClient().postgres.generate_database_credential(endpoint=lakebase_endpoint)
        password = cred.token
    else:
        password = os.environ.get("DATABRICKS_TOKEN", "")
        if not password:
            from databricks.sdk import WorkspaceClient
            password = WorkspaceClient().config.oauth_token().access_token

    logger.debug("Lakebase conninfo: host=%s db=%s user=%s", pghost, pgdatabase, pguser)
    return (
        f"host={pghost} port={pgport} dbname={pgdatabase} "
        f"user={pguser} password={password} "
        f"sslmode={pgsslmode} connect_timeout=10"
    )


def _get_pool():
    global _pool
    if _pool is None:
        if not os.environ.get("PGHOST"):
            raise RuntimeError(
                "PGHOST is not set — Lakebase resource not bound or provisioning failed"
            )
        from psycopg_pool import ConnectionPool

        def _on_reconnect_failed(pool) -> None:
            logger.error("Lakebase pool reconnect failed — pool exhausted, falling back to SQL warehouse")

        _pool = ConnectionPool(
            _make_conninfo,
            min_size=1,
            max_size=8,
            open=False,  # don't block startup — open lazily on first use
            reconnect_failed=_on_reconnect_failed,
        )
        _pool.open(wait=False)  # background open: connect attempts happen async, won't block
        logger.info("Lakebase connection pool opened in background (host=%s db=%s)",
                    os.environ.get("PGHOST"), os.environ.get("PGDATABASE", "postgres"))
    return _pool


def execute_query(sql: str, params: dict | None = None) -> list[dict]:
    """Execute a postgres query and return rows as a list of dicts."""
    import psycopg.rows
    pool = _get_pool()
    try:
        with pool.connection(timeout=10) as conn:
            with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                cur.execute(sql, params or {})
                return [dict(r) for r in cur.fetchall()]
    except Exception as e:
        logger.error("Lakebase execute_query failed: %s", e)
        raise


@contextmanager
def get_connection() -> Generator:
    """Context manager that yields a psycopg Connection from the pool."""
    pool = _get_pool()
    try:
        with pool.connection(timeout=10) as conn:
            yield conn
    except Exception as e:
        logger.error("Lakebase get_connection failed: %s", e)
        raise


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
        logger.info("Lakebase connection pool closed")
