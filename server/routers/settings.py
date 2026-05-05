"""App settings endpoints - Cloud infrastructure connections management."""

import json
import logging
import os
import uuid
from datetime import datetime
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)


def _require_admin(request: Request) -> str:
    """Raise 403 if the requesting user is not an admin. Returns email on success."""
    email = request.headers.get("X-Forwarded-Email", os.getenv("USER", "dev@local"))
    perms = _load_user_permissions()
    admins = perms.get("admins", [])
    # Mirror user.py::_get_user_role: if no admins configured yet, everyone is
    # admin (fresh deploy). Only enforce the list once admins have been set.
    if admins and email not in admins:
        raise HTTPException(status_code=403, detail="Admin role required")
    return email

# File-based storage (fallback / dev only — production uses Delta tables)
SETTINGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
CLOUD_CONNECTIONS_FILE = os.path.join(SETTINGS_DIR, "cloud_connections.json")
WEBHOOK_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "webhook_settings.json")
WAREHOUSE_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "warehouse_settings.json")
TELEMETRY_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "telemetry_settings.json")
PRICING_SETTINGS_FILE = os.path.join(SETTINGS_DIR, "pricing_settings.json")
USER_PERMISSIONS_FILE = os.path.join(SETTINGS_DIR, "user_permissions.json")
# Legacy file path for backward compatibility
AZURE_CONNECTIONS_FILE = os.path.join(SETTINGS_DIR, "azure_connections.json")


# ── Delta table helpers (config tables that survive deploys) ──────────────────

def _config_table(name: str) -> str:
    from server.db import get_catalog_schema
    catalog, schema = get_catalog_schema()
    return f"`{catalog}`.`{schema}`.`{name}`"


def _ensure_config_table(ddl: str) -> None:
    from server.db import execute_write
    execute_write(ddl, None)


def _ensure_contract_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_contract_settings')} "
        f"(start_date STRING, end_date STRING, total_commit_usd DOUBLE, "
        f"notes STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_connections_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_cloud_connections')} "
        f"(id STRING NOT NULL, name STRING, provider STRING, created_at STRING, "
        f"config_json STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_webhook_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_webhook_settings')} "
        f"(slack_webhook_url STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_warehouse_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_warehouse_settings')} "
        f"(warehouse_id STRING, http_path STRING, warehouse_name STRING, "
        f"switched_at STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_telemetry_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_telemetry_settings')} "
        f"(catalog STRING, schema_name STRING, table_prefix STRING, "
        f"updated_at TIMESTAMP) USING DELTA"
    )


def _ensure_auth_mode_table() -> None:
    _ensure_config_table(
        f"CREATE TABLE IF NOT EXISTS {_config_table('app_auth_settings')} "
        f"(mode STRING, updated_at TIMESTAMP) USING DELTA"
    )


def _save_auth_mode_to_table(mode: str) -> None:
    from server.db import execute_write
    _ensure_auth_mode_table()
    table = _config_table("app_auth_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (mode, updated_at) VALUES (:mode, current_timestamp())",
        {"mode": mode},
    )


def restore_auth_mode_from_delta() -> None:
    """Read saved auth mode from Delta table and apply it. Called at startup after warehouse ready."""
    try:
        from server.db import execute_query, set_auth_mode_override
        table = _config_table("app_auth_settings")
        rows = execute_query(f"SELECT mode FROM {table} LIMIT 1", None, no_cache=True)
        if rows and rows[0].get("mode"):
            mode = rows[0]["mode"]
            set_auth_mode_override(mode)
            logger.info(f"Restored auth mode override from Delta table: {mode}")
    except Exception as e:
        logger.warning(f"Could not restore auth mode from Delta table (non-fatal): {e}")


class CloudConnectionCreate(BaseModel):
    name: str
    provider: str  # "azure", "aws", "gcp"
    # Azure fields
    tenant_id: Optional[str] = None
    subscription_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    # AWS fields
    aws_account_id: Optional[str] = None
    access_key_id: Optional[str] = None
    secret_access_key: Optional[str] = None
    region: Optional[str] = None
    # GCP fields
    project_id: Optional[str] = None
    service_account_key: Optional[str] = None


def _load_connections_from_table() -> list[dict]:
    from server.db import execute_query
    table = _config_table("app_cloud_connections")
    rows = execute_query(f"SELECT * FROM {table} ORDER BY created_at", None, no_cache=True)
    result = []
    for r in rows:
        conn: dict = {
            "id": r["id"],
            "name": r["name"],
            "provider": r["provider"],
            "created_at": r["created_at"],
        }
        if r.get("config_json"):
            try:
                conn.update(json.loads(r["config_json"]))
            except Exception:
                pass
        result.append(conn)
    return result


def _save_all_connections_to_table(connections: list[dict]) -> None:
    from server.db import execute_write
    _ensure_connections_table()
    table = _config_table("app_cloud_connections")
    execute_write(f"DELETE FROM {table}", None)
    _top_level = {"id", "name", "provider", "created_at"}
    for conn in connections:
        config = {k: v for k, v in conn.items() if k not in _top_level}
        execute_write(
            f"INSERT INTO {table} (id, name, provider, created_at, config_json, updated_at) "
            f"VALUES (:id, :name, :provider, :created_at, :config_json, current_timestamp())",
            {
                "id": conn.get("id", ""),
                "name": conn.get("name", ""),
                "provider": conn.get("provider", ""),
                "created_at": conn.get("created_at", ""),
                "config_json": json.dumps(config),
            },
        )


def _upsert_connection_to_table(conn: dict) -> None:
    from server.db import execute_write
    _ensure_connections_table()
    table = _config_table("app_cloud_connections")
    _top_level = {"id", "name", "provider", "created_at"}
    config = {k: v for k, v in conn.items() if k not in _top_level}
    execute_write(f"DELETE FROM {table} WHERE id = :id", {"id": conn["id"]})
    execute_write(
        f"INSERT INTO {table} (id, name, provider, created_at, config_json, updated_at) "
        f"VALUES (:id, :name, :provider, :created_at, :config_json, current_timestamp())",
        {
            "id": conn["id"],
            "name": conn.get("name", ""),
            "provider": conn.get("provider", ""),
            "created_at": conn.get("created_at", ""),
            "config_json": json.dumps(config),
        },
    )


def _delete_connection_from_table(connection_id: str) -> None:
    from server.db import execute_write
    _ensure_connections_table()
    table = _config_table("app_cloud_connections")
    execute_write(f"DELETE FROM {table} WHERE id = :id", {"id": connection_id})


def _load_connections() -> list[dict]:
    """Load cloud connections from Delta table, falling back to local file."""
    try:
        conns = _load_connections_from_table()
        if conns:
            return conns
        # Table empty — check file for migration data
    except Exception as e:
        logger.warning(f"Could not load connections from Delta table: {e}")

    # Fallback: local file
    file_conns = _load_connections_from_file()
    if file_conns:
        try:
            _save_all_connections_to_table(file_conns)
            logger.info(f"Migrated {len(file_conns)} cloud connection(s) from file to Delta table")
        except Exception as e:
            logger.warning(f"Could not migrate connections to Delta: {e}")
    return file_conns


def _load_connections_from_file() -> list[dict]:
    """Load cloud connections from local JSON files (legacy / dev fallback)."""
    if os.path.exists(CLOUD_CONNECTIONS_FILE):
        try:
            with open(CLOUD_CONNECTIONS_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return []
    if os.path.exists(AZURE_CONNECTIONS_FILE):
        try:
            with open(AZURE_CONNECTIONS_FILE) as f:
                connections = json.load(f)
            for conn in connections:
                if "provider" not in conn:
                    conn["provider"] = "azure"
            _save_connections_to_file(connections)
            return connections
        except (json.JSONDecodeError, IOError):
            return []
    return []


def _save_connections_to_file(connections: list[dict]) -> None:
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(CLOUD_CONNECTIONS_FILE, "w") as f:
        json.dump(connections, f, indent=2)


def _save_connections(connections: list[dict]) -> None:
    """Save cloud connections to Delta table (primary) and file (dev fallback)."""
    try:
        _save_all_connections_to_table(connections)
    except Exception as e:
        logger.warning(f"Could not save connections to Delta table: {e}")
    _save_connections_to_file(connections)


def _mask_connection(conn: dict) -> dict:
    """Mask sensitive fields in a connection for API response."""
    masked = dict(conn)
    for secret_field in ("client_secret", "secret_access_key", "service_account_key"):
        val = masked.get(secret_field)
        if val and len(val) > 4:
            masked[secret_field] = "***" + val[-4:]
        elif val:
            masked[secret_field] = "****"
    return masked


@router.get("/config")
async def get_app_config():
    """Return current app configuration: warehouse, identity, and storage location."""
    from server.db import get_catalog_schema, get_workspace_client

    result: dict[str, Any] = {
        "warehouse": None,
        "identity": None,
        "storage_location": None,
    }

    # SQL Warehouse info
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    warehouse_id = http_path.split("/")[-1] if http_path else None
    if warehouse_id:
        try:
            w = get_workspace_client()
            wh = w.warehouses.get(warehouse_id)
            result["warehouse"] = {
                "id": wh.id,
                "name": wh.name,
                "size": wh.cluster_size,
                "state": str(wh.state.value) if wh.state else "UNKNOWN",
            }
        except Exception as e:
            logger.warning(f"Could not fetch warehouse details: {e}")
            result["warehouse"] = {"id": warehouse_id, "name": None, "size": None, "state": "UNKNOWN"}

    # Service principal / current identity
    try:
        w = get_workspace_client()
        me = w.current_user.me()
        result["identity"] = {
            "display_name": me.display_name,
            "user_name": me.user_name,
        }
    except Exception as e:
        logger.warning(f"Could not fetch current identity: {e}")

    # Storage location (catalog.schema)
    try:
        catalog, schema = get_catalog_schema()
        result["storage_location"] = {"catalog": catalog, "schema": schema}
    except Exception as e:
        logger.warning(f"Could not fetch catalog/schema: {e}")

    return result


@router.get("/tables")
async def get_tables_status(request: Request):
    """Return status of each MV table: exists, row count, max date, days behind."""
    from server.db import get_catalog_schema, execute_query, _user_token

    # Read the raw forwarded token directly — _auth_mode may be locked to "sp"
    # (e.g. warehouse was cold on startup and the scope check failed), which forces
    # _user_token to "" even when x-forwarded-access-token IS present.  Reading the
    # header directly bypasses that lock and ensures table checks always run as the
    # user when the SQL scope is configured.
    _captured_token = (
        request.headers.get("x-forwarded-access-token", "")
        or _user_token.get()
    )

    MV_TABLES = [
        "daily_usage_summary",
        "daily_product_breakdown",
        "daily_workspace_breakdown",
        "sql_tool_attribution",
        "daily_query_stats",
        "dbsql_cost_per_query",
        "app_user_permissions",
        "app_contract_settings",
        "app_cloud_connections",
        "app_webhook_settings",
        "app_warehouse_settings",
        "app_telemetry_settings",
    ]
    # Which tables are conceptually "materialized views" (rebuilt on schedule)
    # vs persistent managed tables
    MV_SET = {
        "daily_usage_summary", "daily_product_breakdown", "daily_workspace_breakdown",
        "sql_tool_attribution", "daily_query_stats", "dbsql_cost_per_query",
    }

    try:
        catalog, schema = get_catalog_schema()
    except Exception as e:
        return {"catalog": None, "schema": None, "tables": [], "error": str(e)}

    from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError
    from datetime import date

    # Tables that don't have a usage_date column — use an alternate date expression or skip date
    date_expr_overrides = {
        "dbsql_cost_per_query": "CAST(MAX(start_time) AS DATE)",
    }
    no_date_tables = {
        "app_user_permissions", "app_contract_settings", "app_cloud_connections",
        "app_webhook_settings", "app_warehouse_settings", "app_telemetry_settings",
    }

    min_date_expr_overrides = {
        "dbsql_cost_per_query": "CAST(MIN(start_time) AS DATE)",
    }

    def check_table(table_name: str, fqn: str, table_type: str) -> dict:
        # Pin the user token in this thread so execute_query uses user auth,
        # not the SP fallback (which may lack SELECT on freshly-created tables).
        tok = _user_token.set(_captured_token) if _captured_token else None
        try:
            return _check_table_inner(table_name, fqn, table_type)
        finally:
            if tok is not None:
                _user_token.reset(tok)

    def _check_table_inner(table_name: str, fqn: str, table_type: str) -> dict:
        skip_date = table_name in no_date_tables
        try:
            if skip_date:
                rows = execute_query(f"SELECT COUNT(*) as cnt FROM {fqn}")
                cnt = rows[0]["cnt"] if rows else 0
                return {"name": table_name, "table_type": table_type, "exists": True, "row_count": cnt, "min_date": None, "max_date": None, "days_behind": None}
            else:
                max_expr = date_expr_overrides.get(table_name, "MAX(usage_date)")
                min_expr = min_date_expr_overrides.get(table_name, "MIN(usage_date)")
                rows = execute_query(
                    f"SELECT COUNT(*) as cnt, {max_expr} as max_date, {min_expr} as min_date FROM {fqn}"
                )
                if not rows:
                    return {"name": table_name, "table_type": table_type, "exists": True, "row_count": 0, "min_date": None, "max_date": None, "days_behind": None}
                cnt = rows[0].get("cnt", 0)
                max_date = rows[0].get("max_date")
                min_date = rows[0].get("min_date")
                max_date_str = str(max_date) if max_date else None
                min_date_str = str(min_date) if min_date else None
                days_behind = None
                if max_date_str:
                    from datetime import date as _date
                    try:
                        delta = _date.today() - _date.fromisoformat(max_date_str[:10])
                        days_behind = delta.days
                    except Exception:
                        pass
                return {"name": table_name, "table_type": table_type, "exists": True, "row_count": int(cnt), "min_date": min_date_str, "max_date": max_date_str, "days_behind": days_behind}
        except Exception as e:
            err = str(e)
            if "TABLE_OR_VIEW_NOT_FOUND" in err or "does not exist" in err.lower() or "not found" in err.lower():
                return {"name": table_name, "table_type": table_type, "exists": False, "row_count": None, "min_date": None, "max_date": None, "days_behind": None}
            return {"name": table_name, "table_type": table_type, "exists": None, "row_count": None, "min_date": None, "max_date": None, "days_behind": None, "error": err[:200]}

    # Config tables are created lazily on first save — not existing yet is expected
    CONFIG_TABLES = {
        "app_contract_settings", "app_cloud_connections",
        "app_webhook_settings", "app_warehouse_settings", "app_telemetry_settings",
    }

    # Build task list: (table_name, fqn, table_type)
    tasks = [
        (t, f"`{catalog}`.`{schema}`.`{t}`", "Materialized View" if t in MV_SET else "Table")
        for t in MV_TABLES
    ]

    # Add app telemetry OTel tables if configured
    tel = _load_telemetry_settings()
    tel_catalog = tel.get("catalog", "").strip()
    tel_schema = tel.get("schema_name", "").strip()
    tel_prefix = tel.get("table_prefix", "").strip()
    if tel_catalog and tel_schema:
        otel_tables = ["otel_spans", "otel_metrics", "otel_logs"]
        for ot in otel_tables:
            full_name = f"{tel_prefix}{ot}" if tel_prefix else ot
            fqn = f"`{tel_catalog}`.`{tel_schema}`.`{full_name}`"
            tasks.append((full_name, fqn, "Telemetry"))
            no_date_tables.add(full_name)  # OTel tables don't have usage_date

    results = []
    _TABLE_CHECK_TIMEOUT = 25  # seconds — keeps total request under proxy timeout limits
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(check_table, name, fqn, ttype): (name, fqn, ttype) for name, fqn, ttype in tasks}
        try:
            for fut in as_completed(futures, timeout=_TABLE_CHECK_TIMEOUT):
                results.append(fut.result())
        except FuturesTimeoutError:
            # Some queries didn't finish (cold warehouse). Return partial results:
            # completed futures + placeholder rows for anything still pending.
            completed_names = {r["name"] for r in results}
            for fut, (name, _fqn, ttype) in futures.items():
                if name not in completed_names:
                    results.append({
                        "name": name, "table_type": ttype, "exists": None,
                        "row_count": None, "max_date": None, "days_behind": None,
                        "error": "timed out — warehouse may be starting up",
                    })
            logger.warning("Table status check timed out — warehouse likely cold")

    # Preserve original order and tag optional config tables
    order = {name: i for i, (name, _, _) in enumerate(tasks)}
    results.sort(key=lambda r: order.get(r["name"], 99))
    for r in results:
        if r["name"] in CONFIG_TABLES:
            r["optional"] = True

    # Detect auth/permission failures — surface a top-level auth_error so the UI
    # can show an actionable message instead of per-row ⚠ icons.
    _PERM_SIGNALS = ("PERMISSION_DENIED", "INSUFFICIENT_PRIVILEGES", "not authorized",
                     "Not authorized", "Unauthorized", "User does not have", "403")
    perm_errors = [
        r for r in results
        if r.get("error") and any(s in r["error"] for s in _PERM_SIGNALS)
    ]
    auth_error = None
    if perm_errors and len(perm_errors) >= len(tasks) // 2:
        auth_error = (
            "The app service principal lacks permission to read these tables. "
            "Open the app as a workspace admin (with SQL scope) so queries run under your credentials, "
            "or run dba_deploy.sh to grant the required Unity Catalog permissions."
        )

    # Read MV refresh log (atomic write guarantees no partial read)
    refresh_status = None
    _log_path = os.path.join(os.path.dirname(__file__), "..", "..", ".settings", "mv_refresh_log.json")
    try:
        with open(_log_path) as _f:
            _log = json.load(_f)
        from datetime import datetime as _dt, timezone as _tz
        _last = _dt.strptime(_log["last_refresh_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_tz.utc)
        _hours = (_dt.now(_tz.utc) - _last).total_seconds() / 3600
        refresh_status = {
            "last_refresh_utc": _log["last_refresh_utc"],
            "duration_seconds": _log.get("duration_seconds"),
            "hours_since_refresh": round(_hours, 1),
            "stale": _hours > 26,
            "status": _log.get("status", "unknown"),
        }
        if _log.get("error"):
            refresh_status["error"] = _log["error"]
    except (FileNotFoundError, KeyError, ValueError, OSError):
        pass

    return {"catalog": catalog, "schema": schema, "tables": results, "auth_error": auth_error, "refresh_status": refresh_status}


_CONTRACT_SETTINGS_FILE = os.path.join(
    os.path.dirname(__file__), "..", "..", ".settings", "contract_settings.json"
)

_CONTRACT_EMPTY = {"start_date": None, "end_date": None, "total_commit_usd": None, "notes": ""}


def _load_contract_settings() -> dict:
    """Load contract settings from Delta table, falling back to local file."""
    try:
        from server.db import execute_query
        table = _config_table("app_contract_settings")
        rows = execute_query(f"SELECT * FROM {table} LIMIT 1", None, no_cache=True)
        if rows:
            r = rows[0]
            return {
                "start_date": r.get("start_date"),
                "end_date": r.get("end_date"),
                "total_commit_usd": r.get("total_commit_usd"),
                "notes": r.get("notes") or "",
            }
    except Exception as e:
        logger.warning(f"Could not load contract from Delta table: {e}")

    # Fallback: local file — migrate to Delta if data present
    try:
        with open(_CONTRACT_SETTINGS_FILE) as f:
            data = json.load(f)
        if data.get("start_date"):
            try:
                _save_contract_to_table(data)
                logger.info("Migrated contract settings from file to Delta table")
            except Exception as e:
                logger.warning(f"Could not migrate contract settings to Delta: {e}")
        return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return _CONTRACT_EMPTY.copy()


def _save_contract_to_table(data: dict) -> None:
    from server.db import execute_write
    _ensure_contract_table()
    table = _config_table("app_contract_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (start_date, end_date, total_commit_usd, notes, updated_at) "
        f"VALUES (:start_date, :end_date, :total_commit_usd, :notes, current_timestamp())",
        {
            "start_date": data["start_date"],
            "end_date": data["end_date"],
            "total_commit_usd": float(data["total_commit_usd"]),
            "notes": data.get("notes") or "",
        },
    )


@router.get("/contract")
async def get_contract_settings():
    """Return saved contract terms (or empty defaults)."""
    return _load_contract_settings()


@router.post("/contract")
async def save_contract_settings(body: dict):
    """Persist contract terms after basic validation."""
    from datetime import date as _date
    errors = []
    start = body.get("start_date") or ""
    end = body.get("end_date") or ""
    commit = body.get("total_commit_usd")
    try:
        _date.fromisoformat(start)
    except (ValueError, TypeError):
        errors.append("start_date must be a valid ISO date (YYYY-MM-DD)")
    try:
        _date.fromisoformat(end)
    except (ValueError, TypeError):
        errors.append("end_date must be a valid ISO date (YYYY-MM-DD)")
    if commit is None or not isinstance(commit, (int, float)) or commit <= 0:
        errors.append("total_commit_usd must be a positive number")
    if errors:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="; ".join(errors))
    data = {
        "start_date": start,
        "end_date": end,
        "total_commit_usd": float(commit),
        "notes": (body.get("notes") or "").strip(),
    }
    # Write to Delta table (primary) and file (dev fallback)
    try:
        _save_contract_to_table(data)
    except Exception as e:
        logger.warning(f"Could not save contract to Delta table: {e}")
    os.makedirs(os.path.dirname(_CONTRACT_SETTINGS_FILE), exist_ok=True)
    with open(_CONTRACT_SETTINGS_FILE, "w") as f:
        json.dump(data, f)
    return data


@router.get("/catalog")
async def get_catalog_settings():
    """Return current catalog/schema and whether it's from an override or env vars."""
    from server.db import get_catalog_schema_info
    return get_catalog_schema_info()


@router.post("/catalog")
async def set_catalog_settings(body: dict):
    """Save a catalog/schema override. Clears the query cache so new values take effect immediately."""
    from server.db import save_catalog_override, clear_query_cache
    catalog = (body.get("catalog") or "").strip()
    schema = (body.get("schema") or "").strip()
    if not catalog or not schema:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="catalog and schema are required")
    save_catalog_override(catalog, schema)
    clear_query_cache()
    return {"status": "ok", "catalog": catalog, "schema": schema, "source": "override"}


@router.delete("/catalog")
async def reset_catalog_settings():
    """Remove catalog/schema override and revert to env var values."""
    from server.db import clear_catalog_override, get_catalog_schema_info, clear_query_cache
    clear_catalog_override()
    clear_query_cache()
    return {"status": "ok", **get_catalog_schema_info()}


@router.post("/refresh-mvs")
async def trigger_mv_refresh(request: Request, lookback_days: int = 730):
    """Trigger an immediate MV rebuild with an optional lookback window.

    lookback_days: how many days of history to include (default 730 = 2 years).
    """
    import asyncio
    from server.app import _run_mv_refresh

    user_token = request.headers.get("x-forwarded-access-token") or None
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, lambda: _run_mv_refresh(user_token=user_token, lookback_days=lookback_days))
        failed = {k: v for k, v in result.items() if isinstance(v, str) and v.startswith("error:")}
        if failed:
            return {"status": "partial_error", "lookback_days": lookback_days, "result": result,
                    "errors": failed, "message": f"{len(failed)} table(s) failed to refresh"}
        return {"status": "ok", "lookback_days": lookback_days, "result": result}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/auth-status")
async def get_auth_status_endpoint():
    """Return current auth mode for the settings UI indicator."""
    import os as _os
    from server.db import get_auth_status, get_workspace_client
    status = get_auth_status()
    # Add SP identity and catalog/schema so the UI renders accurate GRANT SQL without placeholders
    try:
        me = get_workspace_client().current_user.me()
        status["sp_display_name"] = me.display_name or me.user_name or ""
        status["sp_client_id"] = _os.getenv("DATABRICKS_CLIENT_ID", me.user_name or "")
    except Exception:
        status["sp_display_name"] = ""
        status["sp_client_id"] = _os.getenv("DATABRICKS_CLIENT_ID", "")
    try:
        from server.db import get_catalog_schema
        cat, sch = get_catalog_schema()
        status["catalog"] = cat
        status["schema"] = sch
    except Exception:
        status["catalog"] = ""
        status["schema"] = ""
    return status


@router.get("/billing-access")
async def check_billing_access():
    """Test whether the SP can read system.billing.usage.

    Always runs as the service principal (clears user token) so the result
    reflects SP grants, not the current user's OAuth permissions.
    Used by the frontend to detect missing post-deploy SP grants.
    """
    from server.db import _user_token, execute_query
    tok = _user_token.set("")
    try:
        execute_query("SELECT 1 FROM system.billing.usage LIMIT 1", no_cache=True)
        return {"ok": True}
    except Exception as e:
        err = str(e)
        if any(s in err.lower() for s in ("permission_denied", "insufficient_privileges", "not authorized", "user does not have")):
            return {"ok": False, "reason": "grants_missing"}
        return {"ok": False, "reason": "error", "error": err[:200]}
    finally:
        _user_token.reset(tok)


class AuthModeRequest(BaseModel):
    mode: str  # "sp" | "auto"


@router.post("/auth-mode")
async def set_auth_mode(body: AuthModeRequest):
    """Override the SQL query auth mode.

    mode='sp'   — force all queries through the service principal.
    mode='auto' — clear the override and re-enable OAuth auto-detection.

    The change takes effect immediately for new requests. A page refresh
    is required for the header badge to update.
    """
    if body.mode not in ("sp", "auto"):
        raise HTTPException(status_code=422, detail="mode must be 'sp' or 'auto'")
    from server.db import set_auth_mode_override
    set_auth_mode_override(body.mode)
    return {"status": "ok", "mode": body.mode}


@router.get("/warehouses")
async def list_warehouses():
    """List all SQL warehouses the user has access to."""
    from server.db import get_user_workspace_client

    current_http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    current_id = current_http_path.split("/")[-1] if current_http_path else None

    try:
        w = get_user_workspace_client()
        warehouses = list(w.warehouses.list())

        result = []
        for wh in warehouses:
            state = str(wh.state.value) if wh.state else "UNKNOWN"
            result.append({
                "id": wh.id,
                "name": wh.name,
                "size": wh.cluster_size,
                "state": state,
                "is_current": wh.id == current_id,
            })

        # If the currently configured warehouse isn't in the list (token visibility gap),
        # try fetching it directly — first with the user token, then fall back to the
        # SP M2M client (handles cases where forwarded OAuth token has narrower scope).
        if current_id and not any(r["id"] == current_id for r in result):
            from server.db import get_workspace_client as _get_sp_client
            wh_info = None
            for label, client in [("user", w), ("sp", _get_sp_client())]:
                try:
                    wh = client.warehouses.get(current_id)
                    state = str(wh.state.value) if wh.state else "UNKNOWN"
                    wh_info = {"id": wh.id, "name": wh.name, "size": wh.cluster_size, "state": state, "is_current": True}
                    break
                except Exception as e2:
                    logger.warning(f"Could not fetch warehouse {current_id} ({label} token): {e2}")
            result.insert(0, wh_info or {"id": current_id, "name": None, "size": None, "state": "UNKNOWN", "is_current": True})

        # Sort: current first, then running, then by name
        result.sort(key=lambda x: (not x["is_current"], x["state"] != "RUNNING", x["name"] or ""))
        return result
    except Exception as e:
        logger.error(f"Failed to list warehouses: {e}")
        # warehouses.list() failed (scope/permissions issue) — try fetching the
        # configured warehouse directly via SP client so we return real name/state.
        if current_id:
            from server.db import get_workspace_client as _sp
            try:
                wh = _sp().warehouses.get(current_id)
                state = str(wh.state.value) if wh.state else "STOPPED"
                return [{"id": wh.id, "name": wh.name, "size": wh.cluster_size, "state": state, "is_current": True}]
            except Exception as e2:
                logger.warning(f"SP warehouses.get fallback also failed: {e2}")
                return [{"id": current_id, "name": None, "size": None, "state": "UNKNOWN", "is_current": True}]
        raise HTTPException(status_code=500, detail=str(e))


def _load_warehouse_settings() -> dict:
    """Load warehouse preference from Delta table, falling back to local file."""
    try:
        from server.db import execute_query
        table = _config_table("app_warehouse_settings")
        rows = execute_query(f"SELECT * FROM {table} LIMIT 1", None, no_cache=True)
        if rows:
            r = rows[0]
            return {
                "warehouse_id": r.get("warehouse_id") or "",
                "http_path": r.get("http_path") or "",
                "warehouse_name": r.get("warehouse_name") or "",
                "switched_at": r.get("switched_at") or "",
            }
    except Exception as e:
        logger.warning(f"Could not load warehouse settings from Delta table: {e}")

    if os.path.exists(WAREHOUSE_SETTINGS_FILE):
        try:
            with open(WAREHOUSE_SETTINGS_FILE) as f:
                data = json.load(f)
            if data.get("warehouse_id"):
                try:
                    _save_warehouse_to_table(data)
                    logger.info("Migrated warehouse settings from file to Delta table")
                except Exception as e:
                    logger.warning(f"Could not migrate warehouse settings to Delta: {e}")
            return data
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def _save_warehouse_to_table(settings: dict) -> None:
    from server.db import execute_write
    _ensure_warehouse_table()
    table = _config_table("app_warehouse_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (warehouse_id, http_path, warehouse_name, switched_at, updated_at) "
        f"VALUES (:warehouse_id, :http_path, :warehouse_name, :switched_at, current_timestamp())",
        {
            "warehouse_id": settings.get("warehouse_id") or "",
            "http_path": settings.get("http_path") or "",
            "warehouse_name": settings.get("warehouse_name") or "",
            "switched_at": settings.get("switched_at") or "",
        },
    )


def _save_warehouse_settings(settings: dict) -> None:
    """Save warehouse preference to Delta table (primary) and file (dev fallback)."""
    try:
        _save_warehouse_to_table(settings)
    except Exception as e:
        logger.warning(f"Could not save warehouse settings to Delta table: {e}")
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(WAREHOUSE_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


class WarehouseSwitch(BaseModel):
    warehouse_id: str


@router.post("/warehouse")
async def switch_warehouse(body: WarehouseSwitch):
    """Switch the active SQL warehouse powering the app."""
    from server.db import get_workspace_client

    warehouse_id = body.warehouse_id
    try:
        w = get_workspace_client()
        # Verify the warehouse exists and is accessible
        wh = w.warehouses.get(warehouse_id)

        # Update the environment variable so all future queries use this warehouse
        new_http_path = f"/sql/1.0/warehouses/{warehouse_id}"
        os.environ["DATABRICKS_HTTP_PATH"] = new_http_path

        state = str(wh.state.value) if wh.state else "UNKNOWN"

        # If the warehouse is stopped, attempt to start it
        if state == "STOPPED":
            try:
                w.warehouses.start(warehouse_id)
                logger.info(f"Started warehouse {warehouse_id} ({wh.name})")
                state = "STARTING"
            except Exception as e:
                logger.warning(f"Could not start warehouse {warehouse_id}: {e}")

        # Persist the warehouse preference to disk so it survives restarts
        _save_warehouse_settings({
            "warehouse_id": warehouse_id,
            "http_path": new_http_path,
            "warehouse_name": wh.name,
            "switched_at": datetime.utcnow().isoformat(),
        })

        logger.info(f"Switched active warehouse to {warehouse_id} ({wh.name})")

        return {
            "success": True,
            "warehouse": {
                "id": wh.id,
                "name": wh.name,
                "size": wh.cluster_size,
                "state": state,
            },
            "http_path": new_http_path,
        }
    except Exception as e:
        logger.error(f"Failed to switch warehouse: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/cloud-provider")
async def get_cloud_provider():
    """Detect the base cloud provider from the Databricks workspace host URL."""
    from server.db import get_workspace_client

    host = os.getenv("DATABRICKS_HOST", "")
    # Try getting host from workspace client if env var is empty
    if not host:
        try:
            w = get_workspace_client()
            host = w.config.host or ""
        except Exception:
            pass

    host = host.lower()
    if ".azuredatabricks.net" in host or "adb-" in host:
        provider = "azure"
    elif ".gcp.databricks.com" in host:
        provider = "gcp"
    else:
        # Default to AWS (.cloud.databricks.com and others)
        provider = "aws"

    return {"provider": provider, "host": host}


@router.get("/cloud-connections")
async def list_cloud_connections():
    """List all cloud connections (secrets are masked)."""
    connections = _load_connections()
    return [_mask_connection(c) for c in connections]


# Keep legacy endpoint for backward compatibility
@router.get("/azure-connections")
async def list_azure_connections():
    """List Azure connections (legacy endpoint, returns all connections)."""
    connections = _load_connections()
    return [_mask_connection(c) for c in connections]


@router.post("/cloud-connections")
async def create_cloud_connection(request: Request, conn: CloudConnectionCreate):
    """Create a new cloud connection."""
    _require_admin(request)
    if conn.provider not in ("azure", "aws", "gcp"):
        raise HTTPException(status_code=400, detail="Invalid provider. Must be azure, aws, or gcp.")

    connections = _load_connections()

    new_conn = {
        "id": str(uuid.uuid4())[:8],
        "name": conn.name,
        "provider": conn.provider,
        "created_at": datetime.utcnow().isoformat(),
    }

    if conn.provider == "azure":
        new_conn.update({
            "tenant_id": conn.tenant_id,
            "subscription_id": conn.subscription_id,
            "client_id": conn.client_id,
            "client_secret": conn.client_secret,
        })
    elif conn.provider == "aws":
        new_conn.update({
            "aws_account_id": conn.aws_account_id,
            "access_key_id": conn.access_key_id,
            "secret_access_key": conn.secret_access_key,
            "region": conn.region,
        })
    elif conn.provider == "gcp":
        new_conn.update({
            "project_id": conn.project_id,
            "service_account_key": conn.service_account_key,
        })

    connections.append(new_conn)
    try:
        _upsert_connection_to_table(new_conn)
    except Exception as e:
        logger.warning(f"Could not save connection to Delta table: {e}")
    _save_connections_to_file(connections)

    logger.info(f"Created {conn.provider.upper()} connection: {conn.name}")

    return _mask_connection(new_conn)


# Keep legacy endpoint for backward compatibility
@router.post("/azure-connections")
async def create_azure_connection(conn: CloudConnectionCreate):
    """Create an Azure connection (legacy endpoint)."""
    conn.provider = "azure"
    return await create_cloud_connection(conn)


@router.delete("/cloud-connections/{connection_id}")
async def delete_cloud_connection(request: Request, connection_id: str):
    """Delete a cloud connection."""
    _require_admin(request)
    connections = _load_connections()
    original_count = len(connections)
    connections = [c for c in connections if c.get("id") != connection_id]

    if len(connections) == original_count:
        raise HTTPException(status_code=404, detail="Connection not found")

    try:
        _delete_connection_from_table(connection_id)
    except Exception as e:
        logger.warning(f"Could not delete connection from Delta table: {e}")
    _save_connections_to_file(connections)
    logger.info(f"Deleted cloud connection: {connection_id}")
    return {"status": "deleted", "id": connection_id}


# Keep legacy endpoint for backward compatibility
@router.delete("/azure-connections/{connection_id}")
async def delete_azure_connection(connection_id: str):
    """Delete an Azure connection (legacy endpoint)."""
    return await delete_cloud_connection(connection_id)


# ── Webhook Settings ─────────────────────────────────────────────────────

class WebhookSettings(BaseModel):
    slack_webhook_url: str = ""


def _load_webhook_settings() -> dict:
    """Load webhook settings from Delta table, falling back to local file."""
    try:
        from server.db import execute_query
        table = _config_table("app_webhook_settings")
        rows = execute_query(f"SELECT * FROM {table} LIMIT 1", None, no_cache=True)
        if rows:
            return {"slack_webhook_url": rows[0].get("slack_webhook_url") or ""}
    except Exception as e:
        logger.warning(f"Could not load webhook settings from Delta table: {e}")

    # Fallback: file
    if os.path.exists(WEBHOOK_SETTINGS_FILE):
        try:
            with open(WEBHOOK_SETTINGS_FILE) as f:
                data = json.load(f)
            if data.get("slack_webhook_url"):
                try:
                    _save_webhook_to_table(data)
                    logger.info("Migrated webhook settings from file to Delta table")
                except Exception as e:
                    logger.warning(f"Could not migrate webhook settings to Delta: {e}")
            return data
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def _save_webhook_to_table(settings: dict) -> None:
    from server.db import execute_write
    _ensure_webhook_table()
    table = _config_table("app_webhook_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (slack_webhook_url, updated_at) "
        f"VALUES (:url, current_timestamp())",
        {"url": settings.get("slack_webhook_url") or ""},
    )


def _save_webhook_settings(settings: dict) -> None:
    """Save webhook settings to Delta table (primary) and file (dev fallback)."""
    try:
        _save_webhook_to_table(settings)
    except Exception as e:
        logger.warning(f"Could not save webhook settings to Delta table: {e}")
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(WEBHOOK_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


@router.get("/webhook")
async def get_webhook_settings() -> dict[str, Any]:
    """Get current webhook settings."""
    settings = _load_webhook_settings()
    # Mask the URL for security
    url = settings.get("slack_webhook_url", "")
    masked = ""
    if url:
        # Only show scheme+host to confirm it's configured without exposing path tokens
        masked = "https://hooks.slack.com/services/****" if "hooks.slack.com" in url else "****"
    return {"slack_webhook_url": masked, "configured": bool(url)}


@router.post("/webhook")
async def save_webhook_settings(request: Request, settings: WebhookSettings) -> dict[str, Any]:
    """Save webhook settings."""
    _require_admin(request)
    _save_webhook_settings({"slack_webhook_url": settings.slack_webhook_url})
    logger.info("Webhook settings updated")
    return {"status": "saved"}


@router.post("/webhook/test")
async def test_webhook(request: Request) -> dict[str, Any]:
    """Send a test message to the configured Slack webhook."""
    _require_admin(request)
    settings = _load_webhook_settings()
    url = settings.get("slack_webhook_url", "")
    if not url:
        return {"success": False, "error": "No webhook URL configured"}

    payload = {
        "text": "Cost Observability & Control - Test notification. Your webhook is working!"
    }
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                return {"success": True, "message": "Test message sent"}
            return {"success": False, "error": f"Slack returned status {resp.status_code}"}
    except Exception as e:
        logger.error(f"Webhook test failed: {e}")
        return {"success": False, "error": str(e)}


@router.post("/webhook/send-alert")
async def send_webhook_alert(alert_data: dict[str, Any]) -> dict[str, Any]:
    """Send an alert notification to the configured Slack webhook."""
    settings = _load_webhook_settings()
    url = settings.get("slack_webhook_url", "")
    if not url:
        return {"success": False, "error": "No webhook URL configured"}

    # Format alert message
    alert_type = alert_data.get("alert_type", "alert")
    usage_date = alert_data.get("usage_date", "unknown")
    daily_spend = alert_data.get("daily_spend", 0)
    change_pct = alert_data.get("change_percent", 0)

    text = (
        f":rotating_light: *Cost Alert: {alert_type.title()}*\n"
        f"Date: {usage_date}\n"
        f"Daily Spend: ${daily_spend:,.2f}\n"
    )
    if change_pct:
        text += f"Change: {change_pct:+.1f}%\n"

    payload = {"text": text}
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                return {"success": True}
            return {"success": False, "error": f"Slack returned status {resp.status_code}"}
    except Exception as e:
        logger.error(f"Webhook alert failed: {e}")
        return {"success": False, "error": str(e)}


# ── Telemetry Settings ────────────────────────────────────────────────────

class TelemetrySettings(BaseModel):
    catalog: str = ""
    schema_name: str = ""
    table_prefix: str = ""


def _load_telemetry_settings() -> dict:
    """Load telemetry settings from Delta table, falling back to local file."""
    try:
        from server.db import execute_query
        table = _config_table("app_telemetry_settings")
        rows = execute_query(f"SELECT * FROM {table} LIMIT 1", None, no_cache=True)
        if rows:
            r = rows[0]
            return {
                "catalog": r.get("catalog") or "",
                "schema_name": r.get("schema_name") or "",
                "table_prefix": r.get("table_prefix") or "",
            }
    except Exception as e:
        logger.warning(f"Could not load telemetry settings from Delta table: {e}")

    if os.path.exists(TELEMETRY_SETTINGS_FILE):
        try:
            with open(TELEMETRY_SETTINGS_FILE) as f:
                data = json.load(f)
            if data.get("catalog"):
                try:
                    _save_telemetry_to_table(data)
                    logger.info("Migrated telemetry settings from file to Delta table")
                except Exception as e:
                    logger.warning(f"Could not migrate telemetry settings to Delta: {e}")
            return data
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def _save_telemetry_to_table(settings: dict) -> None:
    from server.db import execute_write
    _ensure_telemetry_table()
    table = _config_table("app_telemetry_settings")
    execute_write(f"DELETE FROM {table}", None)
    execute_write(
        f"INSERT INTO {table} (catalog, schema_name, table_prefix, updated_at) "
        f"VALUES (:catalog, :schema_name, :table_prefix, current_timestamp())",
        {
            "catalog": settings.get("catalog") or "",
            "schema_name": settings.get("schema_name") or "",
            "table_prefix": settings.get("table_prefix") or "",
        },
    )


def _save_telemetry_settings(settings: dict) -> None:
    """Save telemetry settings to Delta table (primary) and file (dev fallback)."""
    try:
        _save_telemetry_to_table(settings)
    except Exception as e:
        logger.warning(f"Could not save telemetry settings to Delta table: {e}")
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(TELEMETRY_SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


@router.get("/telemetry")
async def get_telemetry_settings() -> dict[str, Any]:
    """Return current app telemetry destination settings.

    Falls back to the app's own catalog/schema (from env) when nothing is saved,
    so OTel table monitoring works out of the box without requiring manual config.
    """
    from server.db import get_catalog_schema
    stored = _load_telemetry_settings()
    # Use stored values if present, otherwise fall back to the app's catalog/schema
    if not stored.get("catalog"):
        try:
            default_catalog, default_schema = get_catalog_schema()
        except Exception:
            default_catalog, default_schema = "", ""
    else:
        default_catalog = stored["catalog"]
        default_schema = stored.get("schema_name", "")
    return {
        "catalog": stored.get("catalog") or default_catalog,
        "schema_name": stored.get("schema_name") or default_schema,
        "table_prefix": stored.get("table_prefix", ""),
        "is_default": not bool(stored.get("catalog")),  # True = using app default, not custom
    }


@router.post("/telemetry")
async def save_telemetry_settings_endpoint(settings: TelemetrySettings) -> dict[str, Any]:
    """Save app telemetry destination settings."""
    _save_telemetry_settings({
        "catalog": settings.catalog,
        "schema_name": settings.schema_name,
        "table_prefix": settings.table_prefix,
    })
    logger.info("Telemetry settings updated")
    return {"status": "ok"}


# ── User Permissions ──────────────────────────────────────────────────────────

class UserPermissionsModel(BaseModel):
    admins: list[str] = []
    consumers: list[str] = []


def _permissions_table() -> str:
    """Return the fully-qualified Delta table name for user permissions."""
    from server.db import get_catalog_schema
    catalog, schema = get_catalog_schema()
    return f"`{catalog}`.`{schema}`.`app_user_permissions`"


def _ensure_permissions_table() -> None:
    """Create the permissions table if it doesn't exist."""
    from server.db import execute_write
    table = _permissions_table()
    execute_write(
        f"CREATE TABLE IF NOT EXISTS {table} "
        f"(role STRING NOT NULL, email STRING NOT NULL, "
        f"updated_at TIMESTAMP) "
        f"USING DELTA",
        None,
    )


def _load_user_permissions() -> dict:
    """Load permissions from Delta table, then local file."""
    try:
        from server.db import execute_query
        _ensure_permissions_table()
        table = _permissions_table()
        rows = execute_query(f"SELECT role, email FROM {table}", None, no_cache=True)
        admins = [r["email"] for r in rows if r.get("role") == "admin"]
        consumers = [r["email"] for r in rows if r.get("role") == "consumer"]
        if admins or consumers:
            logger.info(f"Loaded permissions from Delta table ({len(admins)} admins, {len(consumers)} consumers)")
            return {"admins": admins, "consumers": consumers}
    except Exception as e:
        logger.warning(f"Could not load permissions from Delta table: {e}")

    # Fallback: local file (ephemeral — only useful in dev)
    try:
        if os.path.exists(USER_PERMISSIONS_FILE):
            with open(USER_PERMISSIONS_FILE) as f:
                data = json.load(f)
            return {"admins": data.get("admins", []), "consumers": data.get("consumers", [])}
    except (json.JSONDecodeError, IOError):
        pass
    return {"admins": [], "consumers": []}


def _save_user_permissions_to_table(admins: list[str], consumers: list[str]) -> None:
    """Write permissions to Delta table (replaces all rows)."""
    from server.db import execute_write, clear_query_cache
    # Ensure the table exists before writing. If this raises, the SP lacks
    # CREATE TABLE permission — propagate so the caller gets a clear error.
    _ensure_permissions_table()
    table = _permissions_table()
    execute_write(f"DELETE FROM {table}", None)
    rows = [("admin", e) for e in admins] + [("consumer", e) for e in consumers]
    if rows:
        for role, email in rows:
            execute_write(
                f"INSERT INTO {table} (role, email) VALUES (:role, :email)",
                {"role": role, "email": email},
            )
    # Invalidate cached permission reads so the change is visible immediately
    clear_query_cache("perms")
    logger.info(f"Saved user permissions to Delta table ({len(admins)} admins, {len(consumers)} consumers)")


@router.get("/user-permissions")
async def get_user_permissions(request: Request) -> dict:
    """Return the admin and consumer user lists."""
    perms = _load_user_permissions()
    try:
        from server.db import get_catalog_schema
        catalog, schema = get_catalog_schema()
        perms["table_location"] = f"{catalog}.{schema}.app_user_permissions"
    except Exception:
        perms["table_location"] = None
    # Tell the UI who the current user is so it can show implicit admin status
    perms["current_user"] = request.headers.get("X-Forwarded-Email", os.getenv("USER", "dev@local"))
    return perms


@router.post("/user-permissions")
async def save_user_permissions(request: Request, data: UserPermissionsModel) -> dict:
    """Save permissions to Delta table."""
    _require_admin(request)
    try:
        _save_user_permissions_to_table(data.admins, data.consumers)
        logger.info(f"Permissions saved to Delta table ({len(data.admins)} admins, {len(data.consumers)} consumers)")
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Failed to save permissions: {e}")
        raise HTTPException(status_code=500, detail="Failed to save permissions — check server logs")


# ── Customer Discounts ────────────────────────────────────────────────────────

_ACCOUNT_PRICES_SQL = """
SELECT
  sku_name,
  cloud,
  currency_code,
  usage_unit,
  pricing.default        AS list_price,
  TRY(pricing.effective_list.default) AS effective_list_price,
  price_start_time       AS start_time,
  price_end_time         AS end_time
FROM system.billing.account_prices
WHERE price_end_time IS NULL
   OR price_end_time > CURRENT_TIMESTAMP
ORDER BY sku_name, cloud
"""

_LIST_PRICES_SQL = """
SELECT
  sku_name,
  cloud,
  currency_code,
  usage_unit,
  pricing.default        AS list_price,
  TRY(pricing.effective_list.default) AS effective_list_price,
  price_start_time       AS start_time,
  price_end_time         AS end_time
FROM system.billing.list_prices
WHERE price_end_time IS NULL
   OR price_end_time > CURRENT_TIMESTAMP
ORDER BY sku_name, cloud
"""


@router.get("/account-prices")
async def get_account_prices() -> dict[str, Any]:
    """Return customer-specific account prices from system.billing.account_prices.

    Falls back to system.billing.list_prices if account_prices is not available
    (the table is currently in private preview).
    """
    from server.db import execute_query as _exec

    _TRANSIENT_ERRORS = ("table", "not found", "does not exist", "cannot resolve", "http_path", "warehouse")

    # Try account_prices first (negotiated rates, private preview)
    try:
        rows = _exec(_ACCOUNT_PRICES_SQL)
        source = "account_prices"
    except Exception as e:
        err = str(e).lower()
        if any(kw in err for kw in _TRANSIENT_ERRORS):
            logger.info(f"system.billing.account_prices not available ({e}), falling back to list_prices")
            try:
                rows = _exec(_LIST_PRICES_SQL)
                source = "list_prices"
            except Exception as e2:
                logger.debug(f"system.billing.list_prices also unavailable: {e2}")
                return {"available": False, "prices": [], "source": None,
                        "message": "Billing price tables not accessible"}
        else:
            logger.warning(f"account_prices query failed: {e}")
            return {"available": False, "prices": [], "source": None, "message": str(e)}

    prices = [
        {
            "sku_name": r.get("sku_name") or "",
            "cloud": r.get("cloud") or "",
            "currency_code": r.get("currency_code") or "USD",
            "usage_unit": r.get("usage_unit") or "DBU",
            "list_price": float(r.get("list_price") or 0),
            "effective_list_price": float(r.get("effective_list_price") or r.get("list_price") or 0),
            "start_time": str(r.get("start_time")) if r.get("start_time") else None,
            "end_time": str(r.get("end_time")) if r.get("end_time") else None,
        }
        for r in rows
    ]
    return {"available": True, "prices": prices, "source": source, "count": len(prices)}


# ── Pricing Mode ──────────────────────────────────────────────────────────────

def _load_pricing_settings() -> dict:
    try:
        with open(PRICING_SETTINGS_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"use_account_prices": False}


def _save_pricing_settings(settings: dict) -> None:
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(PRICING_SETTINGS_FILE, "w") as f:
        json.dump(settings, f)


@router.get("/pricing-mode")
async def get_pricing_mode() -> dict[str, Any]:
    """Return the current pricing mode setting."""
    settings = _load_pricing_settings()
    return {
        "use_account_prices": settings.get("use_account_prices", False),
    }


@router.put("/pricing-mode")
async def set_pricing_mode(data: dict) -> dict[str, Any]:
    """Save the pricing mode setting."""
    use_account_prices = bool(data.get("use_account_prices", False))
    _save_pricing_settings({"use_account_prices": use_account_prices})
    return {"use_account_prices": use_account_prices, "status": "ok"}


# Usage-weighted blended account price multiplier query
_ACCOUNT_PRICE_MULTIPLIER_SQL = """
WITH recent_usage AS (
  SELECT
    u.sku_name,
    u.cloud,
    SUM(u.usage_quantity) AS total_quantity
  FROM system.billing.usage u
  WHERE u.usage_date >= CURRENT_DATE - INTERVAL 30 DAY
    AND u.usage_quantity > 0
  GROUP BY u.sku_name, u.cloud
),
price_comparison AS (
  SELECT
    cu.sku_name,
    cu.total_quantity,
    COALESCE(lp.pricing.default, 0)   AS list_price,
    COALESCE(ap.pricing.default, 0)   AS account_price
  FROM recent_usage cu
  LEFT JOIN system.billing.list_prices lp
    ON cu.sku_name = lp.sku_name AND cu.cloud = lp.cloud AND lp.price_end_time IS NULL
  LEFT JOIN system.billing.account_prices ap
    ON cu.sku_name = ap.sku_name AND cu.cloud = ap.cloud AND ap.price_end_time IS NULL
  WHERE lp.pricing.default > 0
    AND ap.pricing.default > 0
)
SELECT
  SUM(total_quantity * account_price) / NULLIF(SUM(total_quantity * list_price), 0) AS multiplier,
  COUNT(DISTINCT sku_name) AS sku_count,
  SUM(total_quantity * list_price)   AS weighted_list_spend,
  SUM(total_quantity * account_price) AS weighted_account_spend
FROM price_comparison
"""


@router.get("/account-price-multiplier")
async def get_account_price_multiplier() -> dict[str, Any]:
    """Compute a usage-weighted blended account price multiplier.

    Returns the ratio of account-negotiated prices to list prices,
    weighted by recent usage quantity. Used by the frontend to scale
    all spend figures when 'use_account_prices' is enabled.

    Returns multiplier=1.0 if account_prices table is unavailable.
    """
    from server.db import execute_query as _exec

    pricing_settings = _load_pricing_settings()
    use_account_prices = pricing_settings.get("use_account_prices", False)

    if not use_account_prices:
        return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0}

    try:
        rows = _exec(_ACCOUNT_PRICE_MULTIPLIER_SQL)
        if not rows or rows[0].get("multiplier") is None:
            return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0}
        row = rows[0]
        multiplier = float(row["multiplier"])
        sku_count = int(row.get("sku_count") or 0)
        discount_percent = round((1.0 - multiplier) * 100, 2)
        return {
            "multiplier": multiplier,
            "available": True,
            "sku_count": sku_count,
            "discount_percent": discount_percent,
            "weighted_list_spend": float(row.get("weighted_list_spend") or 0),
            "weighted_account_spend": float(row.get("weighted_account_spend") or 0),
        }
    except Exception as e:
        err = str(e).lower()
        if any(kw in err for kw in ("table", "not found", "does not exist", "cannot resolve")):
            logger.info("system.billing.account_prices not available for multiplier computation")
            return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0,
                    "message": "system.billing.account_prices not available (private preview)"}
        logger.warning(f"Account price multiplier computation failed: {e}")
        return {"multiplier": 1.0, "available": False, "sku_count": 0, "discount_percent": 0}
