"""User endpoints."""

import json
import logging
import os

from fastapi import APIRouter, Request

router = APIRouter()
logger = logging.getLogger(__name__)

SETTINGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
USER_PERMISSIONS_FILE = os.path.join(SETTINGS_DIR, "user_permissions.json")


def _load_permissions() -> dict:
    """Load permissions from Delta table, then local file."""
    try:
        from server.db import execute_query, get_catalog_schema
        catalog, schema = get_catalog_schema()
        table = f"`{catalog}`.`{schema}`.`app_user_permissions`"
        rows = execute_query(f"SELECT role, email FROM {table}", None, no_cache=True)
        admins = [r["email"] for r in rows if r.get("role") == "admin"]
        consumers = [r["email"] for r in rows if r.get("role") == "consumer"]
        if admins or consumers:
            return {"admins": admins, "consumers": consumers}
    except Exception as e:
        logger.error(f"Could not load permissions from Delta table: {e}")

    # Fallback: local file (ephemeral, dev only)
    try:
        if os.path.exists(USER_PERMISSIONS_FILE):
            with open(USER_PERMISSIONS_FILE) as f:
                data = json.load(f)
            return {"admins": data.get("admins", []), "consumers": data.get("consumers", [])}
    except (json.JSONDecodeError, IOError):
        pass
    return {"admins": [], "consumers": []}


def _get_user_role(email: str) -> str:
    """Return 'admin' or 'consumer' for the given email based on stored permissions."""
    perms = _load_permissions()
    if email in perms.get("admins", []):
        return "admin"
    if email in perms.get("consumers", []):
        return "consumer"
    # No admins configured yet (fresh deploy) — default everyone to admin
    # so the person who set up the app can immediately configure it.
    if not perms.get("admins"):
        return "admin"
    return "consumer"


@router.get("/me")
async def get_current_user(request: Request):
    """Get current user information."""
    # In Databricks Apps, user info comes from headers
    user_email = request.headers.get("X-Forwarded-Email", os.getenv("USER", "dev@local"))
    user_name = request.headers.get("X-Forwarded-User", user_email.split("@")[0])

    return {
        "email": user_email,
        "name": user_name,
        "role": _get_user_role(user_email),
    }
