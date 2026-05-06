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
    """Build a fresh conninfo string with a current OAuth token.

    Called by the pool for every new physical connection, so tokens are always
    fresh and never stored at rest.
    """
    from databricks.sdk import WorkspaceClient
    pghost = os.environ.get("PGHOST", "")
    pgdatabase = os.environ.get("PGDATABASE", "postgres")
    token = WorkspaceClient().config.oauth_token().access_token
    return (
        f"host={pghost} "
        f"dbname={pgdatabase} "
        "user=token "
        f"password={token} "
        "sslmode=require "
        "connect_timeout=10"
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
            logger.error("Lakebase pool failed to reconnect; continuing on SQL warehouse fallback")

        _pool = ConnectionPool(
            _make_conninfo,
            min_size=1,
            max_size=8,
            open=True,
            reconnect_failed=_on_reconnect_failed,
        )
        logger.info("Lakebase connection pool opened (host=%s db=%s)", os.environ.get("PGHOST"), os.environ.get("PGDATABASE", "postgres"))
    return _pool


@contextmanager
def get_connection() -> Generator:
    """Context manager that yields a psycopg Connection from the pool."""
    pool = _get_pool()
    with pool.connection() as conn:
        yield conn


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
        logger.info("Lakebase connection pool closed")
