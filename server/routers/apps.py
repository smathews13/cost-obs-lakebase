"""Databricks Apps cost analysis API endpoints."""

import logging
import re
import time
from datetime import date, datetime, timedelta
from typing import Any

# Matches standard Databricks service principal UUID format
_SP_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8,12}$",
    re.IGNORECASE,
)

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import Response

from server.db import execute_query, execute_queries_parallel, get_workspace_client

router = APIRouter()
logger = logging.getLogger(__name__)


def get_default_start_date() -> str:
    """Get default start date (last 30 days)."""
    return (date.today() - timedelta(days=30)).isoformat()


def get_default_end_date() -> str:
    """Get default end date (today)."""
    return date.today().isoformat()


# The active_days param controls the "active" filter: apps with usage in
# the last N days of the date range are considered active.
ACTIVE_DAYS = 7

# ── App name resolution (UUID → human-readable name) ────────────────────

_app_name_cache: dict[str, dict[str, str]] = {}  # uuid → {name, url}
_app_name_cache_time: float = 0
APP_NAME_CACHE_TTL = 3600  # 1 hour - app list rarely changes


def _get_app_registry() -> dict[str, dict[str, str]]:
    """Fetch and cache the UUID → {name, url} mapping from Databricks Apps API.

    Returns a dict keyed by app UUID with values like:
      {"name": "cost-observability", "url": "https://cost-observability-xxx.aws.databricksapps.com"}
    """
    global _app_name_cache, _app_name_cache_time

    now = time.time()
    if _app_name_cache and (now - _app_name_cache_time) < APP_NAME_CACHE_TTL:
        return _app_name_cache

    try:
        w = get_workspace_client()
        registry: dict[str, dict[str, str]] = {}
        for app in w.apps.list():
            app_id = getattr(app, "id", None)
            app_name = getattr(app, "name", None)
            app_url = getattr(app, "url", None) or ""
            # Try to get icon/thumbnail info from the app object
            app_description = getattr(app, "description", None) or ""
            if app_id and app_name:
                registry[app_id] = {
                    "name": app_name,
                    "url": app_url,
                    "description": app_description,
                }
        _app_name_cache = registry
        _app_name_cache_time = now
        logger.info("Refreshed app name cache: %d apps", len(registry))
        return registry
    except Exception as e:
        logger.warning("Failed to fetch app registry: %s", e)
        return _app_name_cache  # return stale cache on error


# ── Connected artifacts cache ────────────────────────────────────────
_app_resources_cache: dict[str, list[dict[str, str]]] = {}
_app_resources_cache_time: float = 0
APP_RESOURCES_CACHE_TTL = 300  # 5 minutes


def _get_app_resources() -> dict[str, list[dict[str, str]]]:
    """Fetch connected artifacts/resources for each app via w.apps.get().

    Returns a dict keyed by app name with lists of resource dicts:
      {"cost-obs": [{"name": "sql-wh", "type": "SQL_WAREHOUSE", "description": "..."}]}
    """
    global _app_resources_cache, _app_resources_cache_time

    now = time.time()
    if _app_resources_cache and (now - _app_resources_cache_time) < APP_RESOURCES_CACHE_TTL:
        return _app_resources_cache

    registry = _get_app_registry()
    if not registry:
        return _app_resources_cache

    try:
        w = get_workspace_client()
        resources_by_app: dict[str, list[dict[str, str]]] = {}
        for uid, entry in registry.items():
            app_name = entry["name"]
            try:
                app_detail = w.apps.get(app_name)
                resources = getattr(app_detail, "resources", None) or []
                app_resources: list[dict[str, str]] = []
                for r in resources:
                    res_name = getattr(r, "name", None) or ""
                    res_description = getattr(r, "description", None) or ""
                    # Resource type might be on the resource or its nested object
                    res_type = ""
                    # Check for serving_endpoint, sql_warehouse, secret, job sub-objects
                    if getattr(r, "serving_endpoint", None):
                        res_type = "SERVING_ENDPOINT"
                        ep = r.serving_endpoint
                        res_name = res_name or getattr(ep, "name", "") or getattr(ep, "endpoint_name", "") or ""
                        res_description = res_description or getattr(ep, "permission", "") or ""
                    elif getattr(r, "sql_warehouse", None):
                        res_type = "SQL_WAREHOUSE"
                        wh = r.sql_warehouse
                        res_name = res_name or getattr(wh, "name", "") or getattr(wh, "id", "") or ""
                        res_description = res_description or getattr(wh, "permission", "") or ""
                    elif getattr(r, "secret", None):
                        res_type = "SECRET"
                        sec = r.secret
                        res_name = res_name or getattr(sec, "key", "") or ""
                        res_description = res_description or getattr(sec, "scope", "") or ""
                    elif getattr(r, "job", None):
                        res_type = "JOB"
                        job = r.job
                        res_name = res_name or getattr(job, "id", "") or ""
                        res_description = res_description or getattr(job, "permission", "") or ""
                    else:
                        res_type = getattr(r, "type", None) or "UNKNOWN"

                    app_resources.append({
                        "name": res_name,
                        "type": res_type,
                        "description": res_description,
                    })
                # Also include the app's run-as service principal from the API
                sp_name = getattr(app_detail, "service_principal_name", None) or ""
                sp_id = getattr(app_detail, "service_principal_id", None)
                if not sp_name and sp_id:
                    sp_name = str(sp_id)
                if sp_name:
                    app_resources.append({
                        "name": sp_name,
                        "type": "SERVICE_PRINCIPAL",
                        "description": "Run-as identity",
                    })
                resources_by_app[app_name] = app_resources
            except Exception as e:
                logger.debug("Failed to get resources for app %s: %s", app_name, e)
                resources_by_app[app_name] = []

        _app_resources_cache = resources_by_app
        _app_resources_cache_time = now
        logger.info("Refreshed app resources cache: %d apps", len(resources_by_app))
        return resources_by_app
    except Exception as e:
        logger.warning("Failed to fetch app resources: %s", e)
        return _app_resources_cache


def _resolve_app_name(app_id: str, registry: dict[str, dict[str, str]]) -> str:
    """Resolve a billing app_id (UUID) to a human-readable name."""
    entry = registry.get(app_id)
    if entry:
        return entry["name"]
    return app_id  # fall back to raw UUID


# ── SQL Queries ──────────────────────────────────────────────────────────

APPS_SUMMARY = """
WITH apps_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.sku_name,
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
    AND u.billing_origin_product = 'APPS'
)
SELECT
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count,
  COUNT(DISTINCT COALESCE(usage_metadata.app_id, 'unknown')) as app_count,
  COUNT(DISTINCT usage_date) as days_in_range,
  MIN(usage_date) as first_date,
  MAX(usage_date) as last_date
FROM apps_usage
"""

# Returns per-app breakdown with last_usage_date for active filtering.
# app_id here is the raw UUID from billing; names are resolved in Python.
APPS_BY_APP_FULL = """
WITH apps_usage AS (
  SELECT
    u.usage_date,
    u.workspace_id,
    u.usage_quantity,
    COALESCE(u.usage_metadata.app_id, 'Unknown') as app_id,
    COALESCE(p.pricing.default, 0) as price_per_dbu
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.cloud = p.cloud
    AND p.price_end_time IS NULL
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.billing_origin_product = 'APPS'
)
SELECT
  app_id,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend,
  COUNT(DISTINCT workspace_id) as workspace_count,
  COUNT(DISTINCT usage_date) as days_active,
  MAX(usage_date) as last_usage_date
FROM apps_usage
GROUP BY app_id
ORDER BY total_spend DESC
"""

# Distinct workspaces per app (for workspace filtering) with name resolution
APPS_WORKSPACES = """
WITH apps_usage AS (
  SELECT DISTINCT
    COALESCE(u.usage_metadata.app_id, 'Unknown') as app_id,
    u.workspace_id
  FROM system.billing.usage u
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.billing_origin_product = 'APPS'
)
SELECT
  a.app_id,
  a.workspace_id,
  COALESCE(ws.workspace_name, CAST(a.workspace_id AS STRING)) as workspace_name
FROM apps_usage a
LEFT JOIN system.access.workspaces_latest ws ON a.workspace_id = ws.workspace_id
"""

# Service principals used as run_as identity for each app
APPS_SERVICE_PRINCIPALS = """
SELECT
  COALESCE(u.usage_metadata.app_id, 'Unknown') as app_id,
  u.identity_metadata.run_as as run_as
FROM system.billing.usage u
WHERE u.usage_date BETWEEN :start_date AND :end_date
  AND u.usage_quantity > 0
  AND u.billing_origin_product = 'APPS'
  AND u.identity_metadata.run_as IS NOT NULL
GROUP BY 1, 2
"""

# Fallback: workspace IDs only (no name resolution)
APPS_WORKSPACES_FALLBACK = """
WITH apps_usage AS (
  SELECT DISTINCT
    COALESCE(u.usage_metadata.app_id, 'Unknown') as app_id,
    u.workspace_id
  FROM system.billing.usage u
  WHERE u.usage_date BETWEEN :start_date AND :end_date
    AND u.usage_quantity > 0
    AND u.billing_origin_product = 'APPS'
)
SELECT
  app_id,
  workspace_id,
  CAST(workspace_id AS STRING) as workspace_name
FROM apps_usage
"""


def _query_app_workspaces(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Query workspace info per app, falling back to IDs if name table is inaccessible."""
    try:
        rows = execute_query(APPS_WORKSPACES, params)
        if rows:
            sample = rows[0]
            logger.info("App workspace sample: workspace_id=%s, workspace_name=%s",
                        sample.get("workspace_id"), sample.get("workspace_name"))
        return rows
    except Exception as e:
        logger.warning("Could not query workspace names (system.access.workspaces_latest may not be accessible): %s", e)
        try:
            return execute_query(APPS_WORKSPACES_FALLBACK, params)
        except Exception:
            return []


APPS_TIMESERIES = """
SELECT
  u.usage_date,
  SUM(u.usage_quantity) as total_dbus,
  SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
  AND u.cloud = p.cloud
  AND p.price_end_time IS NULL
WHERE u.usage_date BETWEEN :start_date AND :end_date
  AND u.usage_quantity > 0
  AND u.billing_origin_product = 'APPS'
GROUP BY u.usage_date
ORDER BY u.usage_date
"""

# Per-app SKU breakdown — what cost categories make up each app's total
APPS_BY_APP_SKU = """
WITH apps_usage AS (
  SELECT
    COALESCE(u.usage_metadata.app_id, 'Unknown') as app_id,
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
    AND u.billing_origin_product = 'APPS'
)
SELECT
  app_id,
  sku_name,
  SUM(usage_quantity) as total_dbus,
  SUM(usage_quantity * price_per_dbu) as total_spend
FROM apps_usage
GROUP BY app_id, sku_name
ORDER BY app_id, total_spend DESC
"""


def _process_apps(
    raw_apps: list[dict[str, Any]],
    active_only: bool,
    end_date_str: str,
    registry: dict[str, dict[str, str]],
    sku_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Split billing rows into registered apps + unregistered bucket.

    Strategy: show every app that exists in the Apps API registry as an
    individual tile (these are "real" deployed apps).  Billing rows whose
    UUID doesn't match any registered app are bucketed as
    "Unregistered apps" (likely synthetic data or deleted apps).

    Returns a dict with keys: apps, inactive_summary, total_app_count,
    active_count, inactive_count, total_spend, unregistered_summary.
    """
    end_dt = datetime.strptime(end_date_str, "%Y-%m-%d").date()
    active_cutoff = end_dt - timedelta(days=ACTIVE_DAYS)

    active_rows: list[dict[str, Any]] = []
    inactive_rows: list[dict[str, Any]] = []

    for r in raw_apps:
        last = r.get("last_usage_date")
        is_active = last is not None and last >= active_cutoff
        r["_is_active"] = is_active
        if is_active:
            active_rows.append(r)
        else:
            inactive_rows.append(r)

    # Build the list we'll return as individual tiles
    source = active_rows if active_only else raw_apps
    total_spend_all = sum(float(r.get("total_spend") or 0) for r in source)

    # Separate registered (real) apps from unregistered billing UUIDs
    registered_apps: list[dict[str, Any]] = []
    unregistered_rows: list[dict[str, Any]] = []

    for r in source:
        raw_id = r.get("app_id") or r.get("app_name") or "Unknown"
        if raw_id in registry:
            registered_apps.append(r)
        else:
            unregistered_rows.append(r)

    apps = []
    for r in registered_apps:
        raw_id = r.get("app_id") or r.get("app_name") or "Unknown"
        spend = float(r.get("total_spend") or 0)
        reg_entry = registry.get(raw_id, {})
        apps.append({
            "app_id": raw_id,
            "app_name": reg_entry.get("name", raw_id),
            "app_url": reg_entry.get("url", ""),
            "total_dbus": float(r.get("total_dbus") or 0),
            "total_spend": spend,
            "workspace_count": r.get("workspace_count") or 0,
            "days_active": r.get("days_active") or 0,
            "last_usage_date": str(r.get("last_usage_date")) if r.get("last_usage_date") else None,
            "percentage": (spend / total_spend_all * 100) if total_spend_all > 0 else 0,
            "is_registered": True,
            "status": "active" if r.get("_is_active") else "inactive",
        })

    # Sort registered apps by spend desc
    apps.sort(key=lambda a: a["total_spend"], reverse=True)

    # Add inactive apps from two additional sources when not in active-only mode:
    #   (A) Registered apps that have NO billing data in this window — they're deployed but idle
    #   (B) Unregistered billing rows with old last_usage (deleted apps with stale billing data)
    if not active_only:
        apps_in_list = {a["app_id"] for a in apps}

        # (A) Registry apps with no billing at all in the window
        for uid, entry in registry.items():
            if uid in apps_in_list:
                continue
            apps.append({
                "app_id": uid,
                "app_name": entry.get("name", uid),
                "app_url": entry.get("url", ""),
                "total_dbus": 0,
                "total_spend": 0,
                "workspace_count": 0,
                "days_active": 0,
                "last_usage_date": None,
                "percentage": 0,
                "is_registered": True,
                "status": "inactive",
            })
            apps_in_list.add(uid)

        # (B) Unregistered billing rows with old last_usage (deleted apps)
        for r in inactive_rows:
            raw_id = r.get("app_id") or r.get("app_name") or "Unknown"
            if raw_id in apps_in_list:
                continue
            spend = float(r.get("total_spend") or 0)
            apps.append({
                "app_id": raw_id,
                "app_name": raw_id,
                "app_url": "",
                "total_dbus": float(r.get("total_dbus") or 0),
                "total_spend": spend,
                "workspace_count": r.get("workspace_count") or 0,
                "days_active": r.get("days_active") or 0,
                "last_usage_date": str(r.get("last_usage_date")) if r.get("last_usage_date") else None,
                "percentage": (spend / total_spend_all * 100) if total_spend_all > 0 else 0,
                "is_registered": False,
                "status": "inactive",
            })
            apps_in_list.add(raw_id)

    # Unregistered apps summary
    unreg_spend = sum(float(r.get("total_spend") or 0) for r in unregistered_rows)
    unreg_dbus = sum(float(r.get("total_dbus") or 0) for r in unregistered_rows)

    # Inactive summary (when showing active only)
    inactive_spend = sum(float(r.get("total_spend") or 0) for r in inactive_rows)
    inactive_dbus = sum(float(r.get("total_dbus") or 0) for r in inactive_rows)

    registered_spend = sum(a["total_spend"] for a in apps)

    # Attach per-app SKU breakdown if available
    if sku_rows:
        sku_by_app: dict[str, list[dict[str, Any]]] = {}
        for row in sku_rows:
            aid = row.get("app_id") or "Unknown"
            if aid not in registry:
                continue  # skip unregistered
            sku_by_app.setdefault(aid, []).append({
                "sku_name": row.get("sku_name") or "Unknown",
                "total_dbus": float(row.get("total_dbus") or 0),
                "total_spend": float(row.get("total_spend") or 0),
            })
        for app in apps:
            breakdown = sku_by_app.get(app["app_id"], [])
            app_spend = app["total_spend"]
            for item in breakdown:
                item["percentage"] = (item["total_spend"] / app_spend * 100) if app_spend > 0 else 0
            app["sku_breakdown"] = breakdown

    return {
        "apps": apps,
        "total_spend": registered_spend,
        "total_app_count": len(apps),
        "active_count": sum(1 for a in apps if a.get("status") == "active"),
        "inactive_count": sum(1 for a in apps if a.get("status") == "inactive"),
        "inactive_summary": {
            "count": len(inactive_rows),
            "total_spend": inactive_spend,
            "total_dbus": inactive_dbus,
            "percentage": (inactive_spend / (total_spend_all + inactive_spend) * 100)
            if (total_spend_all + inactive_spend) > 0
            else 0,
        },
        "unregistered_summary": {
            "count": len(unregistered_rows),
            "total_spend": unreg_spend,
            "total_dbus": unreg_dbus,
            "percentage": (unreg_spend / total_spend_all * 100) if total_spend_all > 0 else 0,
        },
    }


@router.get("/summary")
async def get_apps_summary(
    start_date: str = Query(default=None, description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(default=None, description="End date (YYYY-MM-DD)"),
) -> dict[str, Any]:
    """Get Databricks Apps cost summary."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    results = execute_query(APPS_SUMMARY, params)

    if not results:
        return {
            "total_dbus": 0,
            "total_spend": 0,
            "workspace_count": 0,
            "app_count": 0,
            "days_in_range": 0,
            "avg_daily_spend": 0,
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }

    row = results[0]
    days = row.get("days_in_range") or 1
    total_spend = float(row.get("total_spend") or 0)

    return {
        "total_dbus": float(row.get("total_dbus") or 0),
        "total_spend": total_spend,
        "workspace_count": row.get("workspace_count") or 0,
        "app_count": row.get("app_count") or 0,
        "days_in_range": days,
        "avg_daily_spend": total_spend / days if days > 0 else 0,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
        "first_date": str(row.get("first_date")) if row.get("first_date") else None,
        "last_date": str(row.get("last_date")) if row.get("last_date") else None,
    }


@router.get("/dashboard-bundle")
async def get_apps_dashboard_bundle(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    active_only: bool = Query(default=False, description="Show only apps active in last 7 days"),
) -> dict[str, Any]:
    """Get all Apps dashboard data in a single request."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    # Fetch app registry (UUID → name) — needed to filter queries to registered apps
    registry = _get_app_registry()
    app_filter = _build_app_id_filter(registry)

    # Build a filtered timeseries query for registered apps only
    filtered_timeseries = f"""
    SELECT
      u.usage_date,
      SUM(u.usage_quantity) as total_dbus,
      SUM(u.usage_quantity * COALESCE(p.pricing.default, 0)) as total_spend
    FROM system.billing.usage u
    LEFT JOIN system.billing.list_prices p
      ON u.sku_name = p.sku_name
      AND u.cloud = p.cloud
      AND p.price_end_time IS NULL
    WHERE u.usage_date BETWEEN :start_date AND :end_date
      AND u.usage_quantity > 0
      AND u.billing_origin_product = 'APPS'
      {app_filter}
    GROUP BY u.usage_date
    ORDER BY u.usage_date
    """

    queries = [
        ("summary", lambda: execute_query(APPS_SUMMARY, params)),
        ("apps", lambda: execute_query(APPS_BY_APP_FULL, params)),
        ("timeseries", lambda: execute_query(filtered_timeseries, params)),
        ("sku_breakdown", lambda: execute_query(APPS_BY_APP_SKU, params)),
        ("workspaces", lambda: _query_app_workspaces(params)),
        ("service_principals", lambda: execute_query(APPS_SERVICE_PRINCIPALS, params)),
    ]

    results = execute_queries_parallel(queries)

    # Build workspace lookup per app_id (name → id mapping)
    workspace_rows = results.get("workspaces", []) or []
    app_workspace_map: dict[str, list[str]] = {}  # app_id → [workspace_name, ...]
    all_workspaces: dict[str, str] = {}  # workspace_name → workspace_id
    for row in workspace_rows:
        app_id = row.get("app_id", "")
        ws_name = str(row.get("workspace_name", ""))
        ws_id = str(row.get("workspace_id", ""))
        if app_id not in app_workspace_map:
            app_workspace_map[app_id] = []
        if ws_name not in app_workspace_map[app_id]:
            app_workspace_map[app_id].append(ws_name)
        all_workspaces[ws_name] = ws_id

    # Get days_in_range from the raw summary (needed for avg calc)
    summary_data = results.get("summary", [])
    days_in_range = 1
    if summary_data:
        days_in_range = summary_data[0].get("days_in_range") or 1

    # Process apps with name resolution + active/inactive split
    raw_apps = results.get("apps", []) or []
    sku_rows = results.get("sku_breakdown", []) or []
    apps_result = _process_apps(raw_apps, active_only, params["end_date"], registry, sku_rows)

    # Attach workspace names to each processed app
    for app in apps_result["apps"]:
        app["workspace_names"] = app_workspace_map.get(app["app_id"], [])

    # Build summary from registered apps only (not all billing UUIDs)
    reg_spend = apps_result["total_spend"]
    reg_dbus = sum(a["total_dbus"] for a in apps_result["apps"])
    summary = {
        "total_dbus": reg_dbus,
        "total_spend": reg_spend,
        "workspace_count": len({a.get("workspace_count", 0) for a in apps_result["apps"]}),
        "app_count": apps_result["total_app_count"],
        "days_in_range": days_in_range,
        "avg_daily_spend": reg_spend / days_in_range if days_in_range > 0 else 0,
    }

    # Format timeseries — single aggregate line
    timeseries_data = results.get("timeseries", []) or []
    timeseries = sorted(
        [
            {"date": str(row.get("usage_date")), "Total": float(row.get("total_spend") or 0)}
            for row in timeseries_data
        ],
        key=lambda x: x["date"],
    )

    # Fetch connected artifacts
    resources_by_app = _get_app_resources()
    connected_artifacts: list[dict[str, Any]] = []
    for uid, entry in registry.items():
        app_name = entry["name"]
        for res in resources_by_app.get(app_name, []):
            connected_artifacts.append({
                "app_id": uid,
                "app_name": app_name,
                "artifact_name": res["name"],
                "artifact_type": res["type"],
                "artifact_description": res["description"],
            })

    # Add service principal run_as identities from billing as SERVICE_PRINCIPAL artifacts.
    # Show all non-null run_as values from billing — the SQL already filters IS NOT NULL.
    sp_rows = results.get("service_principals", []) or []
    seen_sp: set[tuple[str, str]] = set()
    for row in sp_rows:
        app_id = str(row.get("app_id", ""))
        run_as = str(row.get("run_as", ""))
        if not app_id or not run_as:
            continue
        key = (app_id, run_as)
        if key in seen_sp:
            continue
        seen_sp.add(key)
        app_name = registry.get(app_id, {}).get("name", app_id)
        connected_artifacts.append({
            "app_id": app_id,
            "app_name": app_name,
            "artifact_name": run_as,
            "artifact_type": "SERVICE_PRINCIPAL",
            "artifact_description": "Run-as identity",
        })

    return {
        "summary": summary,
        "apps": apps_result,
        "timeseries": {"timeseries": timeseries, "categories": ["Total"]},
        "connected_artifacts": connected_artifacts,
        "workspaces": [{"id": ws_id, "name": ws_name} for ws_name, ws_id in sorted(all_workspaces.items(), key=lambda x: x[0])],
        "active_only": active_only,
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }


# ── KPI Trend (registered-apps-only) ─────────────────────────────────

def _build_app_id_filter(registry: dict[str, dict[str, str]]) -> str:
    """Build a SQL IN-clause for registered app UUIDs."""
    if not registry:
        return "AND 1=0"  # no registered apps → empty result
    ids = ", ".join(f"'{uid}'" for uid in registry)
    return f"AND u.usage_metadata.app_id IN ({ids})"


@router.get("/kpi-trend")
async def get_apps_kpi_trend(
    kpi: str = Query(..., description="KPI: apps_spend, apps_dbus, apps_count"),
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    granularity: str = Query("daily", description="daily, weekly, monthly"),
) -> dict[str, Any]:
    """KPI trend filtered to registered apps only."""
    params = {
        "start_date": start_date or get_default_start_date(),
        "end_date": end_date or get_default_end_date(),
    }

    registry = _get_app_registry()
    app_filter = _build_app_id_filter(registry)

    if kpi == "apps_spend":
        query = f"""
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date BETWEEN :start_date AND :end_date
            AND u.usage_quantity > 0
            AND u.billing_origin_product = 'APPS'
            {app_filter}
        )
        SELECT usage_date as date, SUM(usage_quantity * price_per_dbu) as value
        FROM usage_with_price
        GROUP BY usage_date
        ORDER BY usage_date
        """
    elif kpi == "apps_dbus":
        query = f"""
        SELECT u.usage_date as date, SUM(u.usage_quantity) as value
        FROM system.billing.usage u
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.billing_origin_product = 'APPS'
          {app_filter}
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
    elif kpi == "apps_count":
        query = f"""
        SELECT u.usage_date as date,
               COUNT(DISTINCT u.usage_metadata.app_id) as value
        FROM system.billing.usage u
        WHERE u.usage_date BETWEEN :start_date AND :end_date
          AND u.usage_quantity > 0
          AND u.billing_origin_product = 'APPS'
          {app_filter}
        GROUP BY u.usage_date
        ORDER BY u.usage_date
        """
    else:
        return {"error": f"Unknown KPI: {kpi}"}

    try:
        results = execute_query(query, params)
    except Exception as e:
        logger.error("Apps KPI trend query failed for %s: %s", kpi, e)
        return {
            "kpi": kpi, "granularity": granularity, "data_points": [],
            "summary": {"period_start_value": 0, "period_end_value": 0,
                         "change_amount": 0, "change_percent": 0,
                         "min_value": 0, "max_value": 0, "avg_value": 0,
                         "trend": "flat"},
        }

    daily_points = [{"date": str(r["date"]), "value": float(r["value"] or 0)} for r in results]

    # Aggregate into weekly/monthly buckets
    if granularity == "weekly" and daily_points:
        buckets: dict[str, list[float]] = {}
        for dp in daily_points:
            d = datetime.strptime(dp["date"], "%Y-%m-%d")
            week_start = d - timedelta(days=d.weekday())
            key = week_start.strftime("%Y-%m-%d")
            buckets.setdefault(key, []).append(dp["value"])
        data_points = [{"date": k, "value": sum(v)} for k, v in sorted(buckets.items())]
    elif granularity == "monthly" and daily_points:
        buckets_m: dict[str, list[float]] = {}
        for dp in daily_points:
            key = dp["date"][:7] + "-01"
            buckets_m.setdefault(key, []).append(dp["value"])
        data_points = [{"date": k, "value": sum(v)} for k, v in sorted(buckets_m.items())]
    else:
        data_points = daily_points

    if not data_points:
        return {
            "kpi": kpi, "granularity": granularity, "data_points": [],
            "summary": {"period_start_value": 0, "period_end_value": 0,
                         "change_amount": 0, "change_percent": 0,
                         "min_value": 0, "max_value": 0, "avg_value": 0,
                         "trend": "flat"},
        }

    all_values = [dp["value"] for dp in data_points]
    start_val = all_values[0]
    end_val = all_values[-1]
    change = end_val - start_val
    change_pct = (change / start_val * 100) if start_val > 0 else 0
    trend = "flat" if abs(change_pct) < 5 else ("increasing" if change_pct > 0 else "decreasing")

    return {
        "kpi": kpi,
        "granularity": granularity,
        "data_points": data_points,
        "summary": {
            "period_start_value": round(start_val, 2),
            "period_end_value": round(end_val, 2),
            "change_amount": round(change, 2),
            "change_percent": round(change_pct, 2),
            "min_value": round(min(all_values), 2),
            "max_value": round(max(all_values), 2),
            "avg_value": round(sum(all_values) / len(all_values), 2),
            "trend": trend,
        },
    }


# ── Thumbnail proxy ──────────────────────────────────────────────────

# Cache thumbnails in memory to avoid repeated HTTP calls
_thumbnail_cache: dict[str, bytes | None] = {}
_thumbnail_cache_time: dict[str, float] = {}
THUMBNAIL_CACHE_TTL = 600  # 10 minutes

# Paths to try for app thumbnails (order matters)
_THUMBNAIL_PATHS = [
    "/static/thumbnail.png",
    "/static/dbfavicon.png",
    "/favicon.ico",
]


@router.get("/thumbnail")
async def get_app_thumbnail(
    app_id: str = Query(..., description="App UUID"),
) -> Response:
    """Proxy an app's thumbnail image to avoid CORS/auth issues."""
    import os

    now = time.time()

    # Check cache
    if app_id in _thumbnail_cache:
        cached_time = _thumbnail_cache_time.get(app_id, 0)
        if (now - cached_time) < THUMBNAIL_CACHE_TTL:
            data = _thumbnail_cache[app_id]
            if data:
                content_type = "image/png" if not data[:4] == b"\x00\x00\x01\x00" else "image/x-icon"
                return Response(content=data, media_type=content_type)
            return Response(status_code=404)

    registry = _get_app_registry()
    entry = registry.get(app_id)
    if not entry or not entry.get("url"):
        _thumbnail_cache[app_id] = None
        _thumbnail_cache_time[app_id] = now
        return Response(status_code=404)

    app_url = entry["url"].rstrip("/")

    # Build multiple auth approaches to try
    auth_headers_list: list[dict[str, str]] = []

    # 1) No auth (some apps serve static files publicly)
    auth_headers_list.append({})

    # 2) Workspace token auth
    try:
        w = get_workspace_client()
        token = getattr(w.config, "token", None)
        if token:
            auth_headers_list.append({"Authorization": f"Bearer {token}"})
    except Exception:
        pass

    # 3) App-level token from environment (if available)
    app_token = os.environ.get("DATABRICKS_TOKEN")
    if app_token:
        auth_headers_list.append({"Authorization": f"Bearer {app_token}"})

    # Try each thumbnail path with each auth approach
    async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
        for path in _THUMBNAIL_PATHS:
            for headers in auth_headers_list:
                try:
                    resp = await client.get(f"{app_url}{path}", headers=headers)
                    if resp.status_code == 200 and len(resp.content) > 100:
                        ct = resp.headers.get("content-type", "")
                        if "image" in ct or "icon" in ct or path.endswith((".png", ".ico")):
                            _thumbnail_cache[app_id] = resp.content
                            _thumbnail_cache_time[app_id] = now
                            media = ct if "image" in ct else "image/png"
                            logger.info("Thumbnail found for app %s at %s%s", entry.get("name"), app_url, path)
                            return Response(content=resp.content, media_type=media)
                except Exception as e:
                    logger.debug("Thumbnail fetch failed for %s%s: %s", app_url, path, e)
                    continue

    logger.info("No thumbnail found for app %s (%s)", entry.get("name"), app_url)
    _thumbnail_cache[app_id] = None
    _thumbnail_cache_time[app_id] = now
    return Response(status_code=404)


# ── Connected artifacts ──────────────────────────────────────────────

@router.get("/connected-artifacts")
async def get_connected_artifacts() -> dict[str, Any]:
    """Get connected artifacts (serving endpoints, warehouses, etc.) for all apps."""
    registry = _get_app_registry()
    resources_by_app = _get_app_resources()

    artifacts: list[dict[str, Any]] = []
    for uid, entry in registry.items():
        app_name = entry["name"]
        app_resources = resources_by_app.get(app_name, [])
        for res in app_resources:
            artifacts.append({
                "app_id": uid,
                "app_name": app_name,
                "artifact_name": res["name"],
                "artifact_type": res["type"],
                "artifact_description": res["description"],
            })

    return {
        "artifacts": artifacts,
        "count": len(artifacts),
    }
