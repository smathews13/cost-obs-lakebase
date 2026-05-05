"""Setup API endpoints for initializing materialized views."""

import json
import logging
import os
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Query, Request

from server.materialized_views import (
    check_materialized_views_exist,
    create_materialized_views,
    get_catalog_schema,
    refresh_materialized_views,
)
from server.db import get_workspace_client, _user_token as _db_user_token

router = APIRouter()
logger = logging.getLogger(__name__)

SETTINGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
GENIE_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "genie_settings.json")

# Simple in-process state for the background create-tables task
_create_task_state: dict = {"status": "idle", "error": None, "started_at": None, "elapsed_seconds": None}  # idle | running | done | error

# Auto-fail bootstrap after this many seconds to prevent infinite spinner
_BOOTSTRAP_TIMEOUT_SECONDS = 25 * 60  # 25 minutes


SYSTEM_TABLE_GRANTS = [
    ("USE CATALOG", "CATALOG", "system"),
    ("USE SCHEMA",  "SCHEMA",  "system.billing"),
    ("SELECT",      "TABLE",   "system.billing.usage"),
    ("SELECT",      "TABLE",   "system.billing.list_prices"),
    ("SELECT",      "TABLE",   "system.billing.account_prices"),
    ("USE SCHEMA",  "SCHEMA",  "system.query"),
    ("SELECT",      "TABLE",   "system.query.history"),
    ("USE SCHEMA",  "SCHEMA",  "system.compute"),
    ("SELECT",      "TABLE",   "system.compute.clusters"),
    ("USE SCHEMA",  "SCHEMA",  "system.lakeflow"),
    ("SELECT",      "TABLE",   "system.lakeflow.pipelines"),
    ("USE SCHEMA",  "SCHEMA",  "system.serving"),
    ("SELECT",      "TABLE",   "system.serving.served_entities"),
]


def _grant_sp_schema_access(catalog: str, schema: str) -> dict:
    """Grant the app's SP identity all required permissions via UC REST API.

    Uses the SDK grants API directly — no SQL warehouse required, so this
    works even when the warehouse is stopped or the SP has no CAN_USE yet.
    Warehouse CAN_USE is granted via the permissions REST API.

    Always uses the user OAuth token when present, bypassing any auth_mode lock,
    because the granting user (not the SP) needs metastore admin privileges.

    Returns {"ok": bool, "sp_client_id": str, "applied": int, "failed": int, "errors": list}
    """
    from server.db import _user_token, get_workspace_client
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.service.catalog import SecurableType, PermissionsChange, Privilege

    _PRIV_MAP = {
        "USE CATALOG": Privilege.USE_CATALOG,
        "USE SCHEMA": Privilege.USE_SCHEMA,
        "SELECT": Privilege.SELECT,
        "CREATE TABLE": Privilege.CREATE_TABLE,
    }

    sp_client_id = os.getenv("DATABRICKS_CLIENT_ID", "")
    if not sp_client_id:
        logger.warning("DATABRICKS_CLIENT_ID not set — skipping SP grants")
        return {"ok": False, "sp_client_id": "", "applied": 0, "failed": 0,
                "errors": ["DATABRICKS_CLIENT_ID not set — app has no service principal to grant"]}

    # Always use user token for grants — the user needs metastore admin, not the SP.
    # Bypass auth_mode lock intentionally: even if queries are locked to SP mode,
    # the grant operation must run as the human user who has the privileges.
    user_token = _user_token.get()
    host = os.getenv("DATABRICKS_HOST", "")
    if user_token and host:
        w = WorkspaceClient(host=host, token=user_token, auth_type="pat")
    else:
        w = get_workspace_client()

    ok = failed = 0
    errors: list[str] = []

    def _uc_grant(securable_type: SecurableType, full_name: str, *privileges: str):
        nonlocal ok, failed
        try:
            priv_enums = [_PRIV_MAP[p] for p in privileges if p in _PRIV_MAP]
            w.grants.update(
                securable_type=securable_type,
                full_name=full_name,
                changes=[PermissionsChange(principal=sp_client_id, add=priv_enums)],
            )
            ok += 1
            logger.debug(f"Granted {privileges} on {securable_type} {full_name} to {sp_client_id}")
        except Exception as e:
            err = str(e).lower()
            if "already" in err or "not found" in err or "does not exist" in err:
                ok += 1
            else:
                logger.warning(f"UC grant failed ({full_name}): {e}")
                errors.append(f"{full_name}: {str(e)[:120]}")
                failed += 1

    # System catalog + schemas + tables
    _uc_grant(SecurableType.CATALOG, "system", "USE CATALOG")
    for _, obj_type, obj_name in SYSTEM_TABLE_GRANTS:
        if obj_type == "SCHEMA":
            _uc_grant(SecurableType.SCHEMA, obj_name, "USE SCHEMA")
        elif obj_type == "TABLE":
            _uc_grant(SecurableType.TABLE, obj_name, "SELECT")

    # App catalog + schema
    _uc_grant(SecurableType.CATALOG, catalog, "USE CATALOG")
    _uc_grant(SecurableType.SCHEMA, f"{catalog}.{schema}",
              "USE SCHEMA", "CREATE TABLE", "SELECT")

    logger.info(f"SP grants via SDK API: {ok} ok, {failed} failed for {sp_client_id}")

    # Grant CAN_USE on the SQL warehouse via REST API (not SQL — works even
    # when the SP has no warehouse access yet, making it self-healing on redeploy)
    _grant_warehouse_can_use(w, sp_client_id)

    return {
        "ok": failed == 0,
        "sp_client_id": sp_client_id,
        "applied": ok,
        "failed": failed,
        "errors": errors,
    }


def _grant_warehouse_can_use(w, sp_client_id: str) -> None:
    """Grant CAN_USE on the configured SQL warehouse to the app SP via REST API.

    Called from _grant_sp_schema_access on every /api/setup/status load when
    a user OAuth token is present. Idempotent — re-running after a redeploy
    that creates a new SP re-grants without any manual intervention.
    """
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    if not http_path:
        logger.warning("DATABRICKS_HTTP_PATH not set — skipping warehouse CAN_USE grant")
        return

    # Extract warehouse ID from path like /sql/1.0/warehouses/{id}
    parts = http_path.strip("/").split("/")
    warehouse_id = parts[-1] if parts and parts[-1] != "warehouses" else ""
    if not warehouse_id:
        logger.warning(f"Cannot parse warehouse ID from http_path: {http_path}")
        return

    try:
        w.api_client.do(
            "PATCH",
            f"/api/2.0/permissions/warehouses/{warehouse_id}",
            body={
                "access_control_list": [{
                    "service_principal_name": sp_client_id,
                    "permission_level": "CAN_USE",
                }]
            },
        )
        logger.info(f"Granted CAN_USE on warehouse {warehouse_id} to SP {sp_client_id}")
    except Exception as e:
        logger.warning(f"Failed to grant warehouse CAN_USE on {warehouse_id}: {e}")


@router.get("/status")
async def get_setup_status() -> dict[str, Any]:
    """Check the status of materialized views.

    If tables are missing and a user OAuth token is present (git-deploy / first load),
    automatically kick off table creation in a background thread using the user's
    token — no wizard interaction required. Returns status='initializing' in that case.
    """
    import asyncio as _asyncio
    catalog, schema = get_catalog_schema()
    # Run the blocking SDK call (tables.list) in a thread executor so it doesn't
    # block the async event loop — the frontend polls this every few seconds.
    loop = _asyncio.get_running_loop()
    tables = await loop.run_in_executor(None, check_materialized_views_exist, catalog, schema)

    all_exist = all(tables.values())
    missing = [name for name, exists in tables.items() if not exists]

    if not all_exist:
        # If bootstrap is already running (started by a prior request), keep returning
        # "initializing" so the frontend continues polling instead of showing the wizard.
        if _create_task_state["status"] == "running":
            import time as _time
            started = _create_task_state.get("started_at") or _time.monotonic()
            elapsed = int(_time.monotonic() - started)
            _create_task_state["elapsed_seconds"] = elapsed
            # Auto-fail after timeout so the wizard shows instead of spinning forever
            if elapsed > _BOOTSTRAP_TIMEOUT_SECONDS:
                _create_task_state["status"] = "error"
                _create_task_state["error"] = (
                    f"Table creation timed out after {elapsed // 60} minutes. "
                    "The warehouse may be cold or the billing dataset is very large. "
                    "Use the Setup wizard to retry, or check app logs for details."
                )
                logger.error(f"Bootstrap timed out after {elapsed}s — marking as error")
            else:
                return {
                    "catalog": catalog,
                    "schema": schema,
                    "tables": tables,
                    "all_tables_exist": False,
                    "missing_tables": missing,
                    "status": "initializing",
                    "task": _create_task_state.copy(),
                }

        # If bootstrap previously errored or "done" but tables still missing,
        # fall through to setup_required so the wizard shows instead of looping forever.
        if _create_task_state["status"] in ("error", "done"):
            return {
                "catalog": catalog,
                "schema": schema,
                "tables": tables,
                "all_tables_exist": False,
                "missing_tables": missing,
                "status": "setup_required",
                "task": _create_task_state.copy(),
            }

        # Auto-bootstrap: tables missing + user OAuth active + not already creating
        user_token = _db_user_token.get()
        if user_token:
            import threading, time as _time
            _create_task_state["status"] = "running"
            _create_task_state["error"] = None
            _create_task_state["started_at"] = _time.monotonic()
            _create_task_state["elapsed_seconds"] = 0
            _token_snap = user_token
            _catalog_snap = catalog
            _schema_snap = schema

            def _auto_bootstrap():
                tok = _db_user_token.set(_token_snap)
                try:
                    logger.info("Auto-bootstrapping materialized views with user OAuth token...")
                    results = create_materialized_views(_catalog_snap, _schema_snap)
                    errors = {k: v for k, v in results.items() if isinstance(v, str) and v.startswith("error:")}
                    if errors:
                        first_err = next(iter(errors.values()))
                        _create_task_state["status"] = "error"
                        _create_task_state["error"] = first_err.replace("error: ", "", 1)
                        logger.error(f"Auto-bootstrap failed: {first_err}")
                    else:
                        _create_task_state["status"] = "done"
                        _create_task_state["error"] = None
                        logger.info("Auto-bootstrap complete — granting SP schema access")
                        _grant_sp_schema_access(_catalog_snap, _schema_snap)
                except Exception as exc:
                    _create_task_state["status"] = "error"
                    _create_task_state["error"] = str(exc)
                    logger.error(f"Auto-bootstrap exception: {exc}")
                finally:
                    _db_user_token.reset(tok)

            threading.Thread(target=_auto_bootstrap, daemon=True).start()
            return {
                "catalog": catalog,
                "schema": schema,
                "tables": tables,
                "all_tables_exist": False,
                "missing_tables": missing,
                "status": "initializing",
                "task": _create_task_state.copy(),
            }

    # Tables exist — but if a user OAuth token is present, re-run SP grants in the
    # background. Each git deploy creates a new SP with no grants; auto-bootstrap only
    # fires when tables are missing. Re-granting here is idempotent and non-fatal.
    if all_exist:
        user_token = _db_user_token.get()
        if user_token:
            import threading as _threading
            _token_snap = user_token
            _catalog_snap = catalog
            _schema_snap = schema
            def _bg_grant():
                tok = _db_user_token.set(_token_snap)
                try:
                    _grant_sp_schema_access(_catalog_snap, _schema_snap)
                finally:
                    _db_user_token.reset(tok)
            _threading.Thread(target=_bg_grant, daemon=True).start()

    return {
        "catalog": catalog,
        "schema": schema,
        "tables": tables,
        "all_tables_exist": all_exist,
        "missing_tables": missing,
        "status": "ready" if all_exist else "setup_required",
        "task": _create_task_state.copy(),
    }


@router.post("/reset-bootstrap")
async def reset_bootstrap_state() -> dict[str, Any]:
    """Reset the in-process bootstrap state so auto-init can retry.

    Call this if the app is stuck on the 'Setting up your workspace' spinner.
    Resets the internal task state to 'idle' so the next /status poll will
    attempt auto-bootstrap again (or fall through to setup_required if no
    user token is available).
    """
    prev = _create_task_state.copy()
    _create_task_state["status"] = "idle"
    _create_task_state["error"] = None
    logger.info(f"Bootstrap state manually reset (was: {prev})")
    return {"ok": True, "previous": prev, "current": _create_task_state.copy()}


@router.get("/bootstrap-state")
async def get_bootstrap_state() -> dict[str, Any]:
    """Return current in-process bootstrap task state for debugging."""
    return _create_task_state.copy()


@router.post("/grant-sp-system-access")
async def grant_sp_system_access(request: Request) -> dict[str, Any]:
    """Re-run all SP grants using the current user's OAuth token.

    Call this after a git deploy when the new SP is missing system table or
    app schema grants. Requires the calling user to be a metastore admin or
    account admin so the GRANT statements succeed on system tables.
    Returns a summary of how many grants were applied.
    """
    from server.materialized_views import get_catalog_schema

    # Set the user token explicitly so _grant_sp_schema_access bypasses auth_mode lock
    user_token = request.headers.get("x-forwarded-access-token", "")
    ctx_tok = _db_user_token.set(user_token)
    try:
        catalog, schema = get_catalog_schema()
        result = _grant_sp_schema_access(catalog, schema)
    finally:
        _db_user_token.reset(ctx_tok)

    result["catalog"] = catalog
    result["schema"] = schema
    result["status"] = "ok" if result["ok"] else "partial"
    return result


@router.post("/create-tables")
async def create_tables(
    request: Request,
    background_tasks: BackgroundTasks,
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Create all materialized view tables.

    This will create pre-aggregated tables from system tables for fast queries.
    Tables are created with 365 days of historical data.

    WARNING: This operation can take several minutes on large accounts.
    Set run_in_background=true (default) to run asynchronously.
    """
    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if run_in_background:
        import time as _time
        _create_task_state["status"] = "running"
        _create_task_state["error"] = None
        _create_task_state["started_at"] = _time.monotonic()
        _create_task_state["elapsed_seconds"] = 0
        # Read the raw header token directly — _auth_mode may have been locked to "sp"
        # (e.g. after a scope error on a previous request), which forces _db_user_token
        # to "" even when x-forwarded-access-token IS present in the request.
        # Setup operations must always run as the user, not the SP.
        _token_snap = (
            request.headers.get("x-forwarded-access-token", "")
            or _db_user_token.get()
        )
        background_tasks.add_task(
            _create_tables_task, target_catalog, target_schema, _token_snap
        )
        return {
            "status": "started",
            "message": "Table creation started in background. Check /api/setup/status for progress.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        # Run synchronously (blocking)
        results = create_materialized_views(target_catalog, target_schema)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _create_tables_task(catalog: str, schema: str, user_token: str = ""):
    """Background task to create tables (wizard path).

    Runs as the user (not the SP) so CREATE SCHEMA and CREATE TABLE succeed
    on fresh deployments where the SP has no grants yet.
    """
    logger.info(f"Starting background table creation for {catalog}.{schema}")
    tok = _db_user_token.set(user_token) if user_token else None
    try:
        results = create_materialized_views(catalog, schema)
        logger.info(f"Table creation completed: {results}")

        errors = {k: v for k, v in results.items() if isinstance(v, str) and v.startswith("error:")}
        if errors:
            first_error = next(iter(errors.values()))
            _create_task_state["status"] = "error"
            _create_task_state["error"] = first_error.replace("error: ", "", 1)
        else:
            _create_task_state["status"] = "done"
            _create_task_state["error"] = None
            _grant_sp_schema_access(catalog, schema)
    except Exception as e:
        _create_task_state["status"] = "error"
        _create_task_state["error"] = str(e)
        logger.error(f"Table creation failed: {e}")
    finally:
        if tok is not None:
            _db_user_token.reset(tok)


@router.post("/refresh-tables")
async def refresh_tables(
    background_tasks: BackgroundTasks,
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Refresh all materialized view tables with latest data.

    This rebuilds all tables from scratch with current data.
    Should be run daily to keep data fresh.
    """
    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if run_in_background:
        background_tasks.add_task(
            _refresh_tables_task, target_catalog, target_schema
        )
        return {
            "status": "started",
            "message": "Table refresh started in background. Check /api/setup/status for progress.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        results = refresh_materialized_views(target_catalog, target_schema)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _refresh_tables_task(catalog: str, schema: str):
    """Background task to refresh tables."""
    logger.info(f"Starting background table refresh for {catalog}.{schema}")
    try:
        results = refresh_materialized_views(catalog, schema)
        logger.info(f"Table refresh completed: {results}")
    except Exception as e:
        logger.error(f"Table refresh failed: {e}")


# ============================================================================
# AWS CUR Setup Endpoints
# ============================================================================

@router.get("/aws-cur/status")
async def get_aws_cur_status() -> dict[str, Any]:
    """Check the status of AWS CUR integration.

    Returns information about:
    - Available external locations that might contain CUR data
    - Existing CUR tables (bronze/silver/gold)
    - Whether the system is ready for CUR setup
    """
    from server.aws_cur_setup import check_cur_prerequisites, get_catalog_schema

    catalog, schema = get_catalog_schema()
    prerequisites = check_cur_prerequisites(catalog, schema)

    return {
        "catalog": catalog,
        "schema": schema,
        "external_locations": prerequisites["external_locations"],
        "existing_tables": prerequisites["existing_tables"],
        "tables_exist": len(prerequisites["existing_tables"]) == 3,
        "ready_for_setup": prerequisites["ready"],
        "status": "configured" if len(prerequisites["existing_tables"]) == 3 else "not_configured",
    }


@router.post("/aws-cur/create-tables")
async def create_aws_cur_tables(
    background_tasks: BackgroundTasks,
    s3_path: str = Query(default=None, description="S3 path to CUR data (e.g., s3://bucket/cur-reports/)"),
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    load_data: bool = Query(default=False, description="Load data from S3 after creating tables"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Create AWS CUR medallion tables (bronze/silver/gold).

    This creates the table structure for processing AWS Cost and Usage Reports.

    Prerequisites:
    1. CUR 2.0 must be enabled in AWS Billing Console
    2. CUR data must be exported to S3 (Parquet format)
    3. Unity Catalog External Location must exist pointing to the CUR bucket
    4. Storage Credential must have read access to the S3 bucket

    Args:
        s3_path: S3 path where CUR data is stored (required if load_data=True)
        catalog: Target catalog for tables
        schema: Target schema for tables
        load_data: If True, also loads data from S3 into bronze table
        run_in_background: Run table creation in background
    """
    from server.aws_cur_setup import create_cur_tables, get_catalog_schema

    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if load_data and not s3_path:
        return {
            "status": "error",
            "message": "s3_path is required when load_data=True",
        }

    if run_in_background:
        background_tasks.add_task(
            _create_cur_tables_task, target_catalog, target_schema, s3_path, load_data
        )
        return {
            "status": "started",
            "message": "AWS CUR table creation started in background. Check /api/setup/aws-cur/status for progress.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        results = create_cur_tables(target_catalog, target_schema, s3_path, load_data)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _create_cur_tables_task(catalog: str, schema: str, s3_path: str | None, load_data: bool):
    """Background task to create CUR tables."""
    from server.aws_cur_setup import create_cur_tables

    logger.info(f"Starting background CUR table creation for {catalog}.{schema}")
    try:
        results = create_cur_tables(catalog, schema, s3_path, load_data)
        logger.info(f"CUR table creation completed: {results}")
    except Exception as e:
        logger.error(f"CUR table creation failed: {e}")


@router.post("/aws-cur/refresh")
async def refresh_aws_cur_tables(
    background_tasks: BackgroundTasks,
    s3_path: str = Query(default=None, description="S3 path to CUR data"),
    catalog: str = Query(default=None, description="Target catalog"),
    schema: str = Query(default=None, description="Target schema"),
    run_in_background: bool = Query(default=True, description="Run in background"),
) -> dict[str, Any]:
    """Refresh AWS CUR tables with latest data.

    This incrementally loads new CUR data from S3 and refreshes
    the silver and gold tables.
    """
    from server.aws_cur_setup import refresh_cur_tables, get_catalog_schema

    cat, sch = get_catalog_schema()
    target_catalog = catalog or cat
    target_schema = schema or sch

    if run_in_background:
        background_tasks.add_task(
            _refresh_cur_tables_task, target_catalog, target_schema, s3_path
        )
        return {
            "status": "started",
            "message": "AWS CUR table refresh started in background.",
            "catalog": target_catalog,
            "schema": target_schema,
        }
    else:
        results = refresh_cur_tables(target_catalog, target_schema, s3_path)
        return {
            "status": "completed",
            "catalog": target_catalog,
            "schema": target_schema,
            "results": results,
        }


def _refresh_cur_tables_task(catalog: str, schema: str, s3_path: str | None):
    """Background task to refresh CUR tables."""
    from server.aws_cur_setup import refresh_cur_tables

    logger.info(f"Starting background CUR table refresh for {catalog}.{schema}")
    try:
        results = refresh_cur_tables(catalog, schema, s3_path)
        logger.info(f"CUR table refresh completed: {results}")
    except Exception as e:
        logger.error(f"CUR table refresh failed: {e}")


# ============================================================================
# Warehouse Selection (for first-run when auto-creation fails)
# ============================================================================


@router.post("/select-warehouse")
async def select_warehouse(warehouse_id: str = Query(..., description="Warehouse ID to use")) -> dict[str, Any]:
    """Set the active SQL warehouse for the app.

    Called from the setup wizard when warehouse auto-creation fails (e.g. the
    app service principal doesn't have permission to create warehouses). Lets
    the user pick an existing warehouse to proceed with setup.
    """
    try:
        from databricks.sdk.service.sql import State as WHState
        from server.routers.settings import _save_warehouse_settings

        w = get_workspace_client()
        wh = w.warehouses.get(warehouse_id)
        http_path = f"/sql/1.0/warehouses/{warehouse_id}"
        os.environ["DATABRICKS_HTTP_PATH"] = http_path

        # Start the warehouse if it's stopped so it's ready for queries
        if wh.state in (WHState.STOPPED, WHState.STOPPING):
            logger.info(f"Starting stopped warehouse {warehouse_id}...")
            w.warehouses.start(warehouse_id)

        # Persist so it survives restarts
        _save_warehouse_settings({"warehouse_id": warehouse_id, "http_path": http_path, "warehouse_name": wh.name})

        return {
            "status": "ok",
            "warehouse_id": warehouse_id,
            "warehouse_name": wh.name,
            "http_path": http_path,
        }
    except Exception as e:
        logger.error(f"Failed to select warehouse: {e}")
        return {"status": "error", "message": str(e)}


# ============================================================================
# Warehouse Creation (for first-run when user needs a new warehouse)
# ============================================================================


@router.post("/create-warehouse")
async def create_warehouse(name: str = Query(default="Cost Observability App", description="Warehouse name")) -> dict[str, Any]:
    """Create a new serverless Pro SQL warehouse and set it as the active warehouse.

    Called from the setup wizard when the user wants to create a new warehouse
    instead of selecting an existing one.
    """
    try:
        from databricks.sdk.service.sql import CreateWarehouseRequestWarehouseType
        from server.routers.settings import _save_warehouse_settings

        w = get_workspace_client()

        # Check if a warehouse with this name already exists
        existing = [wh for wh in w.warehouses.list() if wh.name == name]
        if existing:
            wh = existing[0]
            warehouse_id = wh.id
            http_path = f"/sql/1.0/warehouses/{warehouse_id}"
            os.environ["DATABRICKS_HTTP_PATH"] = http_path
            _save_warehouse_settings({"warehouse_id": warehouse_id, "http_path": http_path, "warehouse_name": wh.name})
            return {"status": "ok", "warehouse_id": warehouse_id, "warehouse_name": wh.name, "http_path": http_path, "created": False}

        wh = w.warehouses.create(
            name=name,
            cluster_size="Large",
            warehouse_type=CreateWarehouseRequestWarehouseType.PRO,
            enable_serverless_compute=True,
            min_num_clusters=1,
            max_num_clusters=1,
            auto_stop_mins=30,
        )

        warehouse_id = wh.id
        http_path = f"/sql/1.0/warehouses/{warehouse_id}"
        os.environ["DATABRICKS_HTTP_PATH"] = http_path
        _save_warehouse_settings({"warehouse_id": warehouse_id, "http_path": http_path, "warehouse_name": name})

        logger.info(f"Created warehouse '{name}' ({warehouse_id}) via setup wizard")
        return {"status": "ok", "warehouse_id": warehouse_id, "warehouse_name": name, "http_path": http_path, "created": True}

    except Exception as e:
        logger.error(f"Failed to create warehouse: {e}")
        return {"status": "error", "message": str(e)}


# ============================================================================
# Bootstrap Admin (called on first-run wizard completion)
# ============================================================================


@router.post("/bootstrap-admin")
async def bootstrap_admin(request: Request) -> dict[str, Any]:
    """Save the deploying user as admin on first-run setup completion."""
    # X-Forwarded-Email is injected by Databricks Apps on Azure but may be absent on AWS.
    # Fall back to resolving identity from the forwarded OAuth token via the SDK.
    user_email = request.headers.get("X-Forwarded-Email", "")
    if not user_email:
        try:
            from server.db import get_user_workspace_client
            import asyncio as _asyncio
            loop = _asyncio.get_running_loop()
            me = await loop.run_in_executor(
                None, lambda: get_user_workspace_client().current_user.me()
            )
            user_email = me.user_name or ""
        except Exception as e:
            logger.warning(f"Could not resolve user identity for bootstrap-admin: {e}")
    if not user_email:
        return {"status": "skipped", "reason": "no user email available"}

    try:
        from server.routers.settings import _load_user_permissions, _save_user_permissions_to_table

        perms = _load_user_permissions()
        if user_email in perms.get("admins", []):
            return {"status": "ok", "email": user_email, "role": "admin", "note": "already admin"}

        admins = perms.get("admins", []) + [user_email]
        consumers = perms.get("consumers", [])

        _save_user_permissions_to_table(admins, consumers)
        logger.info(f"Bootstrapped admin in Delta table: {user_email}")
        return {"status": "ok", "email": user_email, "role": "admin"}

    except Exception as e:
        logger.error(f"Bootstrap admin failed: {e}")
        return {"status": "error", "message": str(e)}


# ============================================================================
# Token Generation (for local development)
# ============================================================================


@router.post("/generate-token")
async def generate_token() -> dict[str, Any]:
    """Generate a Databricks PAT using the app's OAuth credentials.

    Useful for local development: once the app is running with OAuth,
    generate a token to use as DATABRICKS_TOKEN in a local .env file.
    """
    try:
        w = get_workspace_client()
        host = w.config.host or os.getenv("DATABRICKS_HOST", "")
        response = w.tokens.create(
            comment="cost-obs local development",
            lifetime_seconds=7776000,  # 90 days
        )
        token_value = response.token_value
        expiry = response.token_info.expiry_time if response.token_info else None
        return {
            "status": "created",
            "token": token_value,
            "host": host,
            "expiry_time": expiry,
        }
    except Exception as e:
        logger.error(f"Failed to generate token: {e}")
        return {"status": "error", "message": str(e)}


# ============================================================================
# Genie Space Setup
# ============================================================================


def _load_genie_settings() -> dict:
    """Load Genie settings from file."""
    if os.path.exists(GENIE_SETTINGS_FILE):
        with open(GENIE_SETTINGS_FILE, "r") as f:
            return json.load(f)
    return {}


def _save_genie_settings(settings: dict) -> None:
    """Save Genie settings to file."""
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(GENIE_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


@router.get("/genie-space/status")
async def get_genie_space_status() -> dict[str, Any]:
    """Check if a Genie Space has been created for this app."""
    settings = _load_genie_settings()
    space_id = settings.get("space_id", "") or os.getenv("GENIE_SPACE_ID", "")
    return {
        "configured": bool(space_id),
        "space_id": space_id or None,
    }


@router.post("/create-genie-space")
async def create_genie_space() -> dict[str, Any]:
    """Create a Genie Space for cost analytics during first-time setup.

    Uses the pre-configured genie_space_config.json to create a space
    via the Databricks Genie API. Stores the resulting space_id in
    .settings/genie_settings.json for the genie router to use.
    """
    # Check if already created
    settings = _load_genie_settings()
    existing_id = settings.get("space_id", "") or os.getenv("GENIE_SPACE_ID", "")
    if existing_id:
        return {
            "status": "already_exists",
            "space_id": existing_id,
            "message": "Genie Space already configured.",
        }

    # Load genie space config
    config_path = os.path.join(os.path.dirname(__file__), "..", "..", "genie_space_config.json")
    config_path = os.path.normpath(config_path)
    if not os.path.exists(config_path):
        return {
            "status": "error",
            "message": "genie_space_config.json not found. Cannot create Genie Space.",
        }

    with open(config_path, "r") as f:
        genie_config = json.load(f)

    # Get auth from workspace client
    try:
        w = get_workspace_client()
        host = w.config.host or ""
        header = w.config.authenticate()
        token = header.get("Authorization", "").replace("Bearer ", "")
    except Exception as e:
        logger.error(f"Failed to get workspace client for Genie setup: {e}")
        return {
            "status": "error",
            "message": f"Failed to authenticate with workspace: {e}",
        }

    if not host.startswith("http"):
        host = f"https://{host}"

    # Get a warehouse ID
    try:
        warehouses = list(w.warehouses.list())
        if not warehouses:
            return {
                "status": "error",
                "message": "No SQL warehouses found. A warehouse is required for the Genie Space.",
            }
        warehouse_id = warehouses[0].id
        logger.info(f"Using warehouse {warehouses[0].name} ({warehouse_id}) for Genie Space")
    except Exception as e:
        logger.error(f"Failed to list warehouses: {e}")
        return {
            "status": "error",
            "message": f"Failed to list SQL warehouses: {e}",
        }

    # Add warehouse_id to config
    genie_config["warehouse_id"] = warehouse_id

    # Create the Genie Space
    import httpx

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{host}/api/2.0/genie/spaces",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=genie_config,
            )

            if response.status_code not in (200, 201):
                logger.error(f"Genie API error: {response.text}")
                return {
                    "status": "error",
                    "message": f"Genie API error ({response.status_code}): {response.text[:200]}",
                }

            space_data = response.json()
            space_id = space_data.get("space_id", "")

            if not space_id:
                return {
                    "status": "error",
                    "message": "Genie API returned success but no space_id.",
                }

            # Save to settings file
            _save_genie_settings({"space_id": space_id, "warehouse_id": warehouse_id})
            logger.info(f"Genie Space created: {space_id}")

            # Grant the app's service principal CAN_RUN on the Genie Space
            try:
                sp_client_id = w.config.client_id or os.getenv("DATABRICKS_CLIENT_ID", "")
                if sp_client_id:
                    perm_response = await client.patch(
                        f"{host}/api/2.0/permissions/genie/{space_id}",
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Content-Type": "application/json",
                        },
                        json={
                            "access_control_list": [{
                                "service_principal_name": sp_client_id,
                                "permission_level": "CAN_RUN",
                            }]
                        },
                    )
                    if perm_response.status_code == 200:
                        logger.info(f"Granted CAN_RUN to service principal {sp_client_id}")
                    else:
                        logger.warning(f"Failed to grant Genie permissions: {perm_response.text[:200]}")
            except Exception as perm_err:
                logger.warning(f"Could not grant Genie permissions to service principal: {perm_err}")

            return {
                "status": "created",
                "space_id": space_id,
                "message": "Genie Space created successfully.",
            }

    except httpx.RequestError as e:
        logger.error(f"Failed to create Genie Space: {e}")
        return {
            "status": "error",
            "message": f"Request to Genie API failed: {e}",
        }
