"""Cost Observability & Control (COC) - FastAPI Application"""

import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, timedelta

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from server.routers import aiml, alerts, apps, aws_actual, azure_actual, gcp_actual, billing, dbsql, dbsql_prpr, genie, health, permissions, query_origin, settings, setup, tagging, use_cases, user, users_groups, warehouse_health

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

logger = logging.getLogger(__name__)


class UserAuthMiddleware:
    """Propagate x-forwarded-access-token into the db layer's ContextVar.

    When Databricks Apps user authorization (Public Preview) is enabled, the
    platform injects the end-user's OAuth token via this header on every request.
    We store it in a ContextVar so get_connection() can use it instead of the SP
    token, giving the user their own UC identity for all SQL queries.

    If the header is absent the ContextVar stays at its default (""), and
    get_connection() falls back to the service-principal path as before.

    Implemented as a pure ASGI middleware (not BaseHTTPMiddleware) because
    BaseHTTPMiddleware runs call_next in a separate task context, which breaks
    ContextVar propagation to downstream request handlers.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            from server.db import _user_token, _auth_mode
            headers = {k.lower(): v for k, v in scope.get("headers", [])}
            raw_token = headers.get(b"x-forwarded-access-token", b"").decode()
            # If auth mode is locked to SP, never use the user token — every query
            # in every request uses the service principal identity consistently.
            token = "" if _auth_mode == "sp" else raw_token
            ctx_token = _user_token.set(token)
            try:
                await self.app(scope, receive, send)
            finally:
                _user_token.reset(ctx_token)
        else:
            await self.app(scope, receive, send)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Middleware for request/response logging with correlation IDs."""

    async def dispatch(self, request: Request, call_next):
        # Generate request ID for correlation
        request_id = str(uuid.uuid4())[:8]
        start_time = time.time()

        # Log incoming request
        logger.info(
            f"[{request_id}] → {request.method} {request.url.path} "
            f"(client: {request.client.host if request.client else 'unknown'})"
        )

        # Process request
        response = await call_next(request)

        # Calculate duration
        duration_ms = (time.time() - start_time) * 1000

        # Log response
        logger.info(
            f"[{request_id}] ← {response.status_code} in {duration_ms:.0f}ms"
        )

        # Add request ID to response headers for debugging
        response.headers["X-Request-ID"] = request_id

        return response


def setup_and_check_warehouse():
    """Set up dedicated warehouse and log configuration.

    This function:
    1. Creates a dedicated Large serverless warehouse if needed (when DATABRICKS_HTTP_PATH is 'auto' or not set)
    2. Uses an existing warehouse if DATABRICKS_HTTP_PATH is configured
    3. Logs the warehouse configuration for verification
    """
    try:
        from server.db import setup_warehouse_connection, get_workspace_client

        # Set up the warehouse connection (creates dedicated warehouse if needed)
        http_path = setup_warehouse_connection()

        # Extract warehouse ID from HTTP path
        warehouse_id = http_path.split("/")[-1] if http_path else None

        if warehouse_id:
            try:
                w = get_workspace_client()
                warehouse = w.warehouses.get(warehouse_id)

                # Log warehouse configuration
                logger.info("=" * 60)
                logger.info("SQL Warehouse Configuration")
                logger.info("=" * 60)
                logger.info(f"  Name: {warehouse.name}")
                logger.info(f"  ID: {warehouse.id}")
                logger.info(f"  Size: {warehouse.cluster_size}")
                logger.info(f"  Type: {'Serverless' if warehouse.enable_serverless_compute else 'Pro'}")
                logger.info(f"  Min Clusters: {warehouse.min_num_clusters}")
                logger.info(f"  Max Clusters: {warehouse.max_num_clusters}")
                logger.info(f"  State: {warehouse.state}")
                logger.info(f"  Auto-Stop: {warehouse.auto_stop_mins} minutes")
                logger.info("=" * 60)

                # Check if warehouse is undersized for 14+ parallel queries
                recommended_size = "Large"
                size_order = ["2X-Small", "X-Small", "Small", "Medium", "Large", "X-Large", "2X-Large", "3X-Large", "4X-Large"]
                current_idx = size_order.index(warehouse.cluster_size) if warehouse.cluster_size in size_order else -1
                recommended_idx = size_order.index(recommended_size) if recommended_size in size_order else 4

                if current_idx < recommended_idx:
                    logger.warning(
                        f"⚠️  Warehouse '{warehouse.name}' is sized {warehouse.cluster_size}. "
                        f"Recommended: {recommended_size} or larger for optimal performance with 14+ parallel queries."
                    )
                else:
                    logger.info(f"✓ Warehouse size {warehouse.cluster_size} meets recommended size ({recommended_size})")

            except Exception as e:
                logger.warning(f"Could not fetch warehouse details: {e}")
        else:
            logger.warning("No warehouse ID found in DATABRICKS_HTTP_PATH")

    except Exception as e:
        logger.error(f"Warehouse setup failed: {e}")
        raise  # This is critical - we can't proceed without a warehouse


def setup_system_table_grants():
    """Grant the active identity access to all required system tables.

    Runs at startup as a non-fatal step. Assumes the first user to deploy
    the app is a workspace admin. If user auth (sql scope) is active the
    grants run as the workspace admin user; otherwise they run as the SP.

    Grants cover every system table the app queries so no manual GRANT
    statements are ever needed after deployment.
    """
    from server.db import execute_query, get_workspace_client

    SYSTEM_TABLES = [
        ("CATALOG", "system"),
        ("SCHEMA",  "system.billing"),
        ("TABLE",   "system.billing.usage"),
        ("TABLE",   "system.billing.list_prices"),
        ("TABLE",   "system.billing.account_prices"),
        ("SCHEMA",  "system.query"),
        ("TABLE",   "system.query.history"),
        ("SCHEMA",  "system.compute"),
        ("TABLE",   "system.compute.clusters"),
        ("SCHEMA",  "system.lakeflow"),
        ("TABLE",   "system.lakeflow.pipelines"),
        ("SCHEMA",  "system.serving"),
        ("TABLE",   "system.serving.served_entities"),
        ("SCHEMA",  "system.access"),
        ("TABLE",   "system.access.audit"),
        ("TABLE",   "system.access.workspaces_latest"),
    ]

    try:
        w = get_workspace_client()
        principal = (w.current_user.me().user_name or "").strip()
        if not principal:
            logger.warning("Could not determine principal for system table grants — skipping")
            return

        logger.info(f"Granting system table access to: {principal}")
        succeeded = failed = 0

        for obj_type, obj_name in SYSTEM_TABLES:
            privilege = "USE CATALOG" if obj_type == "CATALOG" else (
                "USE SCHEMA" if obj_type == "SCHEMA" else "SELECT"
            )
            sql = f"GRANT {privilege} ON {obj_type} {obj_name} TO `{principal}`"
            try:
                execute_query(sql, no_cache=True)
                succeeded += 1
            except Exception as e:
                err = str(e).lower()
                # Already granted or object doesn't exist yet — both are non-fatal
                if "already" in err or "not found" in err or "does not exist" in err:
                    succeeded += 1
                else:
                    logger.warning(f"Grant failed (non-fatal): {sql} — {e}")
                    failed += 1

        logger.info(f"System table grants complete: {succeeded} ok, {failed} failed")

        # Also grant the current identity permission to create the app schema.
        # Needed when sql scope is not configured and the SP runs DDL.
        # Fails silently if the SP isn't a catalog owner/metastore admin.
        from server.db import get_catalog_schema
        catalog, schema = get_catalog_schema()
        for catalog_grant in [
            f"GRANT USE CATALOG ON CATALOG {catalog} TO `{principal}`",
            f"GRANT CREATE SCHEMA ON CATALOG {catalog} TO `{principal}`",
        ]:
            try:
                execute_query(catalog_grant, no_cache=True)
                logger.info(f"Catalog grant succeeded: {catalog_grant}")
            except Exception as e:
                err = str(e).lower()
                if "already" in err or "not found" in err or "does not exist" in err:
                    pass
                else:
                    logger.debug(f"Catalog grant failed (non-fatal — SP may not own catalog): {e}")

        # If running under user OAuth (workspace admin), also pre-grant the SP identity
        # the UC permissions it needs on the app schema so scheduled nightly refresh works
        # without manual grants. Non-fatal — skipped if DATABRICKS_CLIENT_ID is not set.
        sp_client_id = os.getenv("DATABRICKS_CLIENT_ID", "")
        if sp_client_id and sp_client_id != principal:
            http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
            warehouse_id = http_path.split("/")[-1] if http_path and "/" in http_path else ""
            sp_schema_grants = [
                f"GRANT USE CATALOG ON CATALOG {catalog} TO `{sp_client_id}`",
                f"GRANT USE SCHEMA ON SCHEMA {catalog}.{schema} TO `{sp_client_id}`",
                f"GRANT CREATE TABLE ON SCHEMA {catalog}.{schema} TO `{sp_client_id}`",
                f"GRANT SELECT ON SCHEMA {catalog}.{schema} TO `{sp_client_id}`",
            ]
            # Warehouse CAN_USE must be granted via REST API — SQL syntax is invalid.
            # setup.py _grant_warehouse_can_use() handles this on each setup/status call.
            sp_ok = 0
            for grant_sql in sp_schema_grants:
                try:
                    execute_query(grant_sql, no_cache=True)
                    sp_ok += 1
                except Exception as e:
                    err = str(e).lower()
                    if "already" in err:
                        sp_ok += 1
                    else:
                        logger.debug(f"SP pre-grant failed (non-fatal): {grant_sql} — {e}")
            logger.info(f"SP schema pre-grants: {sp_ok}/{len(sp_schema_grants)} applied for {sp_client_id}")

    except Exception as e:
        logger.warning(f"System table grant setup failed (non-fatal): {e}")


def setup_system_access_schema():
    """Enable system.access schema so workspace names resolve in billing views.

    Calls the Unity Catalog SystemSchemas API to enable the 'access' schema on
    the current metastore. This is idempotent — safe to call if already enabled.
    Requires the SP to be a metastore admin or account admin; fails silently
    otherwise (workspace data will still show, just without names).
    """
    try:
        from server.db import get_workspace_client
        w = get_workspace_client()

        # Get the current metastore ID
        metastore = w.metastores.current()
        metastore_id = metastore.metastore_id
        if not metastore_id:
            logger.warning("Could not determine metastore ID — skipping system.access setup")
            return

        # Enable the access schema (idempotent)
        w.system_schemas.enable(metastore_id=metastore_id, schema_name="access")
        logger.info("system.access schema enabled (or already enabled)")

    except Exception as e:
        err = str(e).lower()
        if "already enabled" in err or "already exists" in err:
            logger.info("system.access schema already enabled")
        else:
            logger.warning(
                f"Could not enable system.access schema (non-fatal — workspace names will not resolve): "
                f"{type(e).__name__}: {e}"
            )


def setup_materialized_views():
    """Create materialized views if they don't exist."""
    try:
        from server.materialized_views import (
            check_materialized_views_exist,
            create_materialized_views,
            get_catalog_schema,
        )

        catalog, schema = get_catalog_schema()
        logger.info(f"Checking materialized views in {catalog}.{schema}...")

        # Check which tables exist and have data
        tables = check_materialized_views_exist(catalog, schema)
        missing = [name for name, exists in tables.items() if not exists]

        # Also rebuild if core summary table is empty (stale/failed previous build)
        if not missing:
            from server.db import execute_query
            try:
                result = execute_query(
                    f"SELECT COUNT(*) as cnt FROM {catalog}.{schema}.daily_usage_summary LIMIT 1",
                    no_cache=True,
                )
                if not result or int(result[0].get("cnt", 0)) == 0:
                    logger.info("daily_usage_summary exists but is empty — forcing MV rebuild")
                    missing = ["daily_usage_summary"]
            except Exception:
                pass

        if missing:
            logger.info(f"Creating/rebuilding materialized views: {missing}")
            results = create_materialized_views(catalog, schema)
            success = sum(1 for v in results.values() if v == "created")
            logger.info(f"Materialized views setup complete: {success}/{len(results)} tables built")
        else:
            # Tables exist and have data — refresh in background so startup isn't blocked
            # and the setup wizard check never sees missing tables
            import threading
            def _bg_refresh():
                try:
                    logger.info("Refreshing materialized views in background (post-deploy)...")
                    r = create_materialized_views(catalog, schema)
                    ok = sum(1 for v in r.values() if v == "created")
                    logger.info(f"Background MV refresh complete: {ok}/{len(r)} tables rebuilt")
                except Exception as ex:
                    logger.warning(f"Background MV refresh failed (non-fatal): {ex}")
            threading.Thread(target=_bg_refresh, daemon=True).start()
            logger.info("Materialized views exist — refresh kicked off in background")

    except Exception as e:
        logger.warning(f"Materialized views setup failed (non-fatal): {e}")


def prewarm_cache_sync():
    """Pre-warm the query cache with common queries on startup (synchronous)."""
    try:
        from server.db import execute_query, execute_queries_parallel
        from server.queries import (
            BILLING_SUMMARY,
            BILLING_BY_PRODUCT_FAST,
            BILLING_BY_WORKSPACE,
            BILLING_TIMESERIES_FAST,
            ETL_BREAKDOWN,
        )

        # Default 30-day range
        params = {
            "start_date": (date.today() - timedelta(days=30)).isoformat(),
            "end_date": date.today().isoformat(),
        }

        logger.info("Pre-warming cache with default 30-day queries...")

        # Run fast queries in parallel to warm cache
        queries = [
            ("summary", lambda: execute_query(BILLING_SUMMARY, params)),
            ("products", lambda: execute_query(BILLING_BY_PRODUCT_FAST, params)),
            ("workspaces", lambda: execute_query(BILLING_BY_WORKSPACE, params)),
            ("timeseries", lambda: execute_query(BILLING_TIMESERIES_FAST, params)),
            ("etl", lambda: execute_query(ETL_BREAKDOWN, params)),
        ]

        results = execute_queries_parallel(queries)
        success_count = sum(1 for v in results.values() if v is not None)
        logger.info(f"Cache pre-warming complete: {success_count}/{len(queries)} queries cached")

    except Exception as e:
        logger.warning(f"Cache pre-warming failed (non-fatal): {e}")


def prewarm_all_tabs():
    """Pre-warm cache for ALL tabs (runs in background after initial prewarm)."""
    try:
        from server.db import execute_query, execute_queries_parallel
        from server.routers.tagging import (
            TAGGING_SUMMARY, UNTAGGED_CLUSTERS, UNTAGGED_JOBS,
            UNTAGGED_PIPELINES, UNTAGGED_WAREHOUSES, UNTAGGED_ENDPOINTS,
            COST_BY_TAG, COST_BY_TAG_KEY, TAG_COVERAGE_TIMESERIES,
        )
        from server.routers.aiml import (
            AIML_SUMMARY, FMAPI_PROVIDER_COSTS, SERVERLESS_INFERENCE_BY_ENDPOINT,
            AIML_BY_CATEGORY, AIML_TIMESERIES,
        )
        from server.routers.use_cases import router as use_cases_router
        from server.routers.query_origin import (
            _SUMMARY_SQL, _SUMMARY_SQL_NO_COST,
            _TIMESERIES_SQL, _TIMESERIES_SQL_NO_COST,
            _BY_WAREHOUSE_SQL, _BY_WAREHOUSE_SQL_NO_COST,
        )
        from server.db import get_catalog_schema

        params = {
            "start_date": (date.today() - timedelta(days=30)).isoformat(),
            "end_date": date.today().isoformat(),
        }

        logger.info("Pre-warming ALL tabs cache in background...")

        # Query origin — pre-warm all endpoints in parallel (system.query.history × dbsql_cost_per_query can be slow)
        catalog, schema = get_catalog_schema()

        def _prewarm_origin(sql_cost, sql_no_cost, name):
            try:
                execute_query(sql_cost, params)
                logger.info(f"Pre-warmed query origin {name} (with cost)")
            except Exception:
                try:
                    execute_query(sql_no_cost, params)
                    logger.info(f"Pre-warmed query origin {name} (no cost fallback)")
                except Exception as e:
                    logger.warning(f"Query origin {name} pre-warm failed (non-fatal): {e}")

        origin_prewarm_queries = [
            ("origin_summary", lambda: _prewarm_origin(_SUMMARY_SQL.format(catalog=catalog, schema=schema), _SUMMARY_SQL_NO_COST, "summary")),
            ("origin_timeseries", lambda: _prewarm_origin(_TIMESERIES_SQL.format(catalog=catalog, schema=schema), _TIMESERIES_SQL_NO_COST, "timeseries")),
            ("origin_by_warehouse", lambda: _prewarm_origin(_BY_WAREHOUSE_SQL.format(catalog=catalog, schema=schema), _BY_WAREHOUSE_SQL_NO_COST, "by_warehouse")),
        ]
        execute_queries_parallel(origin_prewarm_queries)

        # Tagging queries
        tagging_queries = [
            ("tag_summary", lambda: execute_query(TAGGING_SUMMARY, params)),
            ("tag_clusters", lambda: execute_query(UNTAGGED_CLUSTERS, params)),
            ("tag_jobs", lambda: execute_query(UNTAGGED_JOBS, params)),
            ("tag_pipelines", lambda: execute_query(UNTAGGED_PIPELINES, params)),
            ("tag_warehouses", lambda: execute_query(UNTAGGED_WAREHOUSES, params)),
            ("tag_endpoints", lambda: execute_query(UNTAGGED_ENDPOINTS, params)),
            ("tag_cost_by_tag", lambda: execute_query(COST_BY_TAG, params)),
            ("tag_keys", lambda: execute_query(COST_BY_TAG_KEY, params)),
            ("tag_timeseries", lambda: execute_query(TAG_COVERAGE_TIMESERIES, params)),
        ]

        # AI/ML queries
        aiml_queries = [
            ("aiml_summary", lambda: execute_query(AIML_SUMMARY, params)),
            ("aiml_providers", lambda: execute_query(FMAPI_PROVIDER_COSTS, params)),
            ("aiml_endpoints", lambda: execute_query(SERVERLESS_INFERENCE_BY_ENDPOINT, params)),
            ("aiml_categories", lambda: execute_query(AIML_BY_CATEGORY, params)),
            ("aiml_timeseries", lambda: execute_query(AIML_TIMESERIES, params)),
        ]

        # Run all queries in parallel
        all_queries = tagging_queries + aiml_queries
        results = execute_queries_parallel(all_queries)
        success_count = sum(1 for v in results.values() if v is not None)
        logger.info(f"Background cache pre-warming complete: {success_count}/{len(all_queries)} queries cached")

    except Exception as e:
        logger.warning(f"Background cache pre-warming failed (non-fatal): {e}")


def _run_mv_refresh(user_token: str | None = None, lookback_days: int = 730) -> dict:
    """Run CREATE OR REPLACE TABLE for all MV tables. Returns results dict."""
    import json
    import os
    import time
    from datetime import datetime, timezone
    from server.materialized_views import refresh_materialized_views
    from server.db import get_catalog_schema, _user_token as _db_user_token

    ctx_tok = None
    if user_token:
        ctx_tok = _db_user_token.set(user_token)
        logger.info("MV refresh triggered with user OAuth token")
    else:
        logger.info("MV refresh running as service principal (no user token)")

    log_dir = os.path.join(os.path.dirname(__file__), "..", ".settings")
    log_path = os.path.join(log_dir, "mv_refresh_log.json")
    log_tmp = log_path + ".tmp"

    refresh_start = time.monotonic()
    start_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    results: dict = {}
    log_data: dict = {"last_refresh_utc": start_utc, "duration_seconds": 0, "mv_timings": {}, "status": "error", "error": "unknown"}
    try:
        catalog, schema = get_catalog_schema()
        results = refresh_materialized_views(catalog, schema, lookback_days=lookback_days)
        mv_timings = results.pop("__mv_timings__", {})
        duration = round(time.monotonic() - refresh_start, 1)
        failed = {k: v for k, v in results.items() if isinstance(v, str) and v.startswith("error:")}
        log_data = {
            "last_refresh_utc": start_utc,
            "duration_seconds": duration,
            "mv_timings": mv_timings,
            "status": "partial_error" if failed else "success",
        }
        if failed:
            log_data["error"] = "; ".join(f"{k}: {v}" for k, v in failed.items())
            logger.error(f"MV refresh: {len(failed)} table(s) failed — {log_data['error']}")
        else:
            logger.info(f"MV refresh complete in {duration}s")
    except Exception as exc:
        duration = round(time.monotonic() - refresh_start, 1)
        log_data = {
            "last_refresh_utc": start_utc,
            "duration_seconds": duration,
            "mv_timings": {},
            "status": "error",
            "error": str(exc)[:500],
        }
        raise
    finally:
        if ctx_tok is not None:
            _db_user_token.reset(ctx_tok)
        try:
            os.makedirs(log_dir, exist_ok=True)
            with open(log_tmp, "w") as f:
                json.dump(log_data, f)
            os.replace(log_tmp, log_path)
        except Exception as log_exc:
            logger.warning(f"Failed to write MV refresh log: {log_exc}")

    return results


def startup_tasks():
    """Run all startup tasks: setup warehouse, setup MVs, warm cache, setup alerts."""
    # Restore saved warehouse preference (if user previously switched warehouses)
    current_http_path = os.environ.get("DATABRICKS_HTTP_PATH", "")
    if current_http_path and current_http_path != "auto":
        try:
            from server.routers.settings import _load_warehouse_settings
            saved = _load_warehouse_settings()
            saved_http_path = saved.get("http_path")
            if saved_http_path and saved_http_path != current_http_path:
                os.environ["DATABRICKS_HTTP_PATH"] = saved_http_path
                logger.info(f"Restored saved warehouse preference: {saved.get('warehouse_name', saved_http_path)}")
        except Exception as e:
            logger.warning(f"Could not restore warehouse preference (non-fatal): {e}")

    # Step 0: Set up dedicated warehouse (creates Large serverless warehouse if needed)
    setup_and_check_warehouse()

    # Step 0a: Restore auth mode override from Delta (survives app restarts/redeployments)
    try:
        from server.routers.settings import restore_auth_mode_from_delta
        restore_auth_mode_from_delta()
    except Exception as e:
        logger.warning(f"Could not restore auth mode from Delta (non-fatal): {e}")

    # Step 0b: Enable system.access schema for workspace name resolution
    setup_system_access_schema()

    # Step 0c: Grant the active identity access to all required system tables
    setup_system_table_grants()

    # Step 0d: Bootstrap Lakebase schema (idempotent — only runs when PGHOST is set)
    if os.environ.get("PGHOST"):
        try:
            from db.bootstrap_lakebase_schema import bootstrap as _lb_bootstrap
            logger.info("Bootstrapping Lakebase schema...")
            _lb_bootstrap()
            logger.info("Lakebase schema bootstrap complete")
        except Exception as e:
            logger.warning(f"Lakebase schema bootstrap failed (non-fatal): {e}")

    # Step 1: Create materialized views if needed
    setup_materialized_views()

    # Step 3: Pre-warm cache (billing - fast queries first)
    prewarm_cache_sync()

    # Step 4: Create default cost monitoring alerts
    # Use a file lock so only one uvicorn worker runs this — all workers share
    # the same filesystem, so fcntl.flock prevents the race that creates duplicates.
    try:
        import fcntl
        from server.alert_manager import create_default_cost_alerts
        lock_path = "/tmp/cost-obs-alert-setup.lock"
        with open(lock_path, "w") as lock_file:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                logger.info("Setting up default cost monitoring alerts...")
                results = create_default_cost_alerts(
                    spike_threshold_percent=20.0,
                    daily_threshold_amount=50000.0,
                    workspace_threshold_amount=10000.0
                )
                logger.info(
                    f"Alert setup complete: {len(results['created'])} created, "
                    f"{len(results['skipped'])} skipped, {len(results['errors'])} errors"
                )
            except BlockingIOError:
                logger.info("Alert setup already running in another worker — skipping")
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)
    except Exception as e:
        logger.warning(f"Alert setup failed (non-fatal): {e}")

    # Step 5: Create default example use case
    try:
        from server.routers.use_cases import create_default_use_case
        logger.info("Setting up default example use case...")
        uc_result = create_default_use_case()
        if uc_result["created"]:
            logger.info("Default use case created successfully")
        elif uc_result["skipped"]:
            logger.info("Default use case already exists, skipped")
        elif uc_result["error"]:
            logger.warning(f"Default use case creation failed: {uc_result['error']}")
    except Exception as e:
        logger.warning(f"Use case setup failed (non-fatal): {e}")

    # Step 6: Pre-warm permissions check (warms SDK auth + caches result for wizard)
    try:
        from server.routers.permissions import _check_permissions_sync
        logger.info("Pre-warming permissions check...")
        _check_permissions_sync()
        logger.info("Permissions pre-warm complete")
    except Exception as e:
        logger.warning(f"Permissions pre-warm failed (non-fatal): {e}")

    # Step 7: Pre-warm ALL tabs (slower queries, runs after alerts)
    prewarm_all_tabs()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Warehouse setup runs synchronously before accepting requests so the
    # setup wizard immediately shows the correct warehouse on first load.
    # Everything else (MV creation, job scheduling, cache prewarm) runs in
    # the background and does not block the app from starting.
    try:
        from server.db import setup_warehouse_connection
        from server.routers.settings import _load_warehouse_settings
        current = os.environ.get("DATABRICKS_HTTP_PATH", "")
        if current and current != "auto":
            saved = _load_warehouse_settings()
            saved_path = saved.get("http_path")
            if saved_path and saved_path != current:
                os.environ["DATABRICKS_HTTP_PATH"] = saved_path
        setup_warehouse_connection()
    except Exception as e:
        logger.warning(f"Warehouse setup during lifespan failed (non-fatal): {e}")

    # Remaining startup tasks run in background
    asyncio.get_event_loop().run_in_executor(None, startup_tasks)

    # Daily MV refresh scheduler — runs at 2am UTC inside the app process.
    # Uses a file lock so only one uvicorn worker fires the refresh.
    async def _daily_mv_refresh_loop():
        from datetime import datetime, timezone, timedelta
        import fcntl
        while True:
            try:
                now = datetime.now(timezone.utc)
                next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
                if next_run <= now:
                    next_run += timedelta(days=1)
                wait = (next_run - datetime.now(timezone.utc)).total_seconds()
                logger.info(f"Next MV refresh scheduled in {wait/3600:.1f}h (at 02:00 UTC)")
                await asyncio.sleep(max(wait, 0))
                # File lock — only one worker runs the refresh
                lock_path = "/tmp/cost-obs-mv-refresh.lock"
                try:
                    with open(lock_path, "w") as lf:
                        fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        logger.info("Running scheduled daily MV refresh...")
                        loop = asyncio.get_event_loop()
                        await loop.run_in_executor(None, _run_mv_refresh)
                        logger.info("Scheduled MV refresh complete")
                        fcntl.flock(lf, fcntl.LOCK_UN)
                except BlockingIOError:
                    logger.info("MV refresh already running in another worker — skipping")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Daily MV refresh loop error: {e}")
                await asyncio.sleep(3600)  # retry in 1h on unexpected error

    scheduler_task = asyncio.create_task(_daily_mv_refresh_loop())
    yield
    scheduler_task.cancel()


app = FastAPI(
    title="Cost Observability & Control (COC)",
    description="Cost observability and analytics control dashboard",
    version="0.1.0",
    lifespan=lifespan,
)

# Request logging middleware
app.add_middleware(RequestLoggingMiddleware)

# User authorization middleware — runs inside logging so requests show correct identity.
# Reads x-forwarded-access-token injected by Databricks Apps when user authorization
# is enabled (Public Preview). No-op when the header is absent.
app.add_middleware(UserAuthMiddleware)

# CORS configuration - externalized for production
# Set CORS_ORIGINS env var for production (comma-separated list of origins)
cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "X-Forwarded-Email"],
)

# Include routers
app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(user.router, prefix="/api/user", tags=["user"])
app.include_router(billing.router, prefix="/api/billing", tags=["billing"])
app.include_router(genie.router, prefix="/api/genie", tags=["genie"])
app.include_router(setup.router, prefix="/api/setup", tags=["setup"])
app.include_router(aiml.router, prefix="/api/aiml", tags=["aiml"])
app.include_router(apps.router, prefix="/api/apps", tags=["apps"])
app.include_router(tagging.router, prefix="/api/tagging", tags=["tagging"])
app.include_router(aws_actual.router, prefix="/api/aws-actual", tags=["aws-actual"])
app.include_router(azure_actual.router, prefix="/api/azure-actual", tags=["azure-actual"])
app.include_router(gcp_actual.router, prefix="/api/gcp-actual", tags=["gcp-actual"])
app.include_router(dbsql.router, prefix="/api/dbsql", tags=["dbsql"])
app.include_router(dbsql_prpr.router, prefix="/api/dbsql-prpr", tags=["dbsql-prpr"])
app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])
app.include_router(use_cases.router, prefix="/api/use-cases", tags=["use-cases"])
app.include_router(permissions.router, prefix="/api/permissions", tags=["permissions"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(users_groups.router, prefix="/api/users-groups", tags=["users-groups"])
app.include_router(query_origin.router, prefix="/api/sql/query-origin", tags=["query-origin"])
app.include_router(warehouse_health.router, prefix="/api/sql/warehouse-health", tags=["warehouse-health"])

# Serve static files in production.
# index.html gets Cache-Control: no-cache so browsers always fetch the latest
# after a deploy (prevents "Failed to fetch dynamically imported module" errors
# when Vite content-hashed chunk filenames change between deploys).
# JS/CSS assets under /assets/ are served as-is — their filenames are content-
# hashed so they can be cached indefinitely by the browser.
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.exists(static_dir):

    class NoCacheHTMLMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            response = await call_next(request)
            content_type = response.headers.get("content-type", "")
            if "text/html" in content_type:
                response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            return response

    app.add_middleware(NoCacheHTMLMiddleware)
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
