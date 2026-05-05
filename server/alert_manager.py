"""Databricks SQL Alert Management for Cost Observability.

This module manages the creation and lifecycle of Databricks SQL Alerts
for cost monitoring and anomaly detection.
"""

import logging
import os
import time
from typing import Any

from cachetools import TTLCache
from databricks.sdk import WorkspaceClient
from databricks.sdk.service import sql

from server.db import get_workspace_client

logger = logging.getLogger(__name__)


def get_sql_warehouse_id() -> str:
    """Get SQL warehouse ID from environment."""
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    if not http_path:
        raise ValueError("DATABRICKS_HTTP_PATH must be set")
    # Extract warehouse ID from http path: /sql/1.0/warehouses/{warehouse_id}
    parts = http_path.split("/")
    if len(parts) >= 5 and parts[1] == "sql":
        return parts[-1]
    raise ValueError(f"Invalid DATABRICKS_HTTP_PATH format: {http_path}")


def create_cost_spike_alert(
    w: WorkspaceClient,
    warehouse_id: str,
    threshold_percent: float = 20.0,
    alert_name: str = "Cost Observability - Daily Spend Spike"
) -> dict[str, Any]:
    """
    Create a Databricks SQL Alert for daily spend spikes.

    This alert runs a query that detects day-over-day spend changes
    above the threshold percentage.

    Args:
        w: Workspace client
        warehouse_id: SQL warehouse ID
        threshold_percent: Minimum percent change to trigger alert
        alert_name: Display name for the alert

    Returns:
        Dictionary with alert_id and status
    """
    try:
        # Create the query that detects spend spikes
        query_text = f"""
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
          WHERE u.usage_date >= CURRENT_DATE - 2
            AND u.usage_quantity > 0
        ),
        daily_spend AS (
          SELECT
            usage_date,
            SUM(usage_quantity * price_per_dbu) as daily_spend
          FROM usage_with_price
          GROUP BY usage_date
        ),
        with_prev AS (
          SELECT
            usage_date,
            daily_spend,
            LAG(daily_spend) OVER (ORDER BY usage_date) as prev_day_spend
          FROM daily_spend
        )
        SELECT
          MAX(usage_date) as alert_date,
          MAX(daily_spend) as current_spend,
          MAX(prev_day_spend) as previous_spend,
          MAX((daily_spend - prev_day_spend) / prev_day_spend * 100) as percent_change
        FROM with_prev
        WHERE usage_date = CURRENT_DATE - 1
          AND prev_day_spend IS NOT NULL
          AND ABS((daily_spend - prev_day_spend) / prev_day_spend * 100) >= {threshold_percent}
        """

        # Create the query first
        query = w.queries.create(
            query=sql.CreateQueryRequestQuery(
                display_name=f"{alert_name} - Query",
                warehouse_id=warehouse_id,
                description="Detects daily spend spikes for cost observability",
                query_text=query_text
            )
        )

        logger.info(f"Created query for spike alert: {query.id}")

        # Create the alert on the query
        # Alert triggers when percent_change value exists (meaning threshold was exceeded)
        alert = w.alerts.create(
            alert=sql.CreateAlertRequestAlert(
                display_name=alert_name,
                query_id=query.id,
                condition=sql.AlertCondition(
                    operand=sql.AlertConditionOperand(
                        column=sql.AlertOperandColumn(name="percent_change")
                    ),
                    op=sql.AlertOperator.GREATER_THAN,
                    threshold=sql.AlertConditionThreshold(
                        value=sql.AlertOperandValue(double_value=float(threshold_percent))
                    )
                )
            )
        )

        logger.info(f"Created cost spike alert: {alert.id}")

        return {
            "success": True,
            "alert_id": alert.id,
            "query_id": query.id,
            "alert_name": alert_name
        }

    except Exception as e:
        logger.error(f"Failed to create cost spike alert: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def create_daily_threshold_alert(
    w: WorkspaceClient,
    warehouse_id: str,
    threshold_amount: float = 50000.0,
    alert_name: str = "Cost Observability - Daily Spend Threshold"
) -> dict[str, Any]:
    """
    Create a Databricks SQL Alert for daily spend exceeding threshold.

    Args:
        w: Workspace client
        warehouse_id: SQL warehouse ID
        threshold_amount: Dollar amount threshold
        alert_name: Display name for the alert

    Returns:
        Dictionary with alert_id and status
    """
    try:
        query_text = f"""
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
          WHERE u.usage_date = CURRENT_DATE - 1
            AND u.usage_quantity > 0
        )
        SELECT
          MAX(usage_date) as alert_date,
          SUM(usage_quantity * price_per_dbu) as daily_spend,
          {threshold_amount} as threshold,
          SUM(usage_quantity * price_per_dbu) - {threshold_amount} as excess_amount
        FROM usage_with_price
        HAVING SUM(usage_quantity * price_per_dbu) > {threshold_amount}
        """

        query = w.queries.create(
            query=sql.CreateQueryRequestQuery(
                display_name=f"{alert_name} - Query",
                warehouse_id=warehouse_id,
                description=f"Detects when daily spend exceeds ${threshold_amount:,.0f}",
                query_text=query_text
            )
        )

        logger.info(f"Created query for threshold alert: {query.id}")

        alert = w.alerts.create(
            alert=sql.CreateAlertRequestAlert(
                display_name=alert_name,
                query_id=query.id,
                condition=sql.AlertCondition(
                    operand=sql.AlertConditionOperand(
                        column=sql.AlertOperandColumn(name="daily_spend")
                    ),
                    op=sql.AlertOperator.GREATER_THAN,
                    threshold=sql.AlertConditionThreshold(
                        value=sql.AlertOperandValue(double_value=threshold_amount)
                    )
                )
            )
        )

        logger.info(f"Created daily threshold alert: {alert.id}")

        return {
            "success": True,
            "alert_id": alert.id,
            "query_id": query.id,
            "alert_name": alert_name
        }

    except Exception as e:
        logger.error(f"Failed to create threshold alert: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def create_workspace_cost_alert(
    w: WorkspaceClient,
    warehouse_id: str,
    threshold_amount: float = 10000.0,
    alert_name: str = "Cost Observability - High Workspace Spend"
) -> dict[str, Any]:
    """
    Create a Databricks SQL Alert for workspaces with high spend.

    Args:
        w: Workspace client
        warehouse_id: SQL warehouse ID
        threshold_amount: Dollar amount threshold per workspace
        alert_name: Display name for the alert

    Returns:
        Dictionary with alert_id and status
    """
    try:
        query_text = f"""
        WITH usage_with_price AS (
          SELECT
            u.usage_date,
            u.workspace_id,
            u.usage_quantity,
            COALESCE(p.pricing.default, 0) as price_per_dbu
          FROM system.billing.usage u
          LEFT JOIN system.billing.list_prices p
            ON u.sku_name = p.sku_name
            AND u.cloud = p.cloud
            AND p.price_end_time IS NULL
          WHERE u.usage_date >= CURRENT_DATE - 7
            AND u.usage_quantity > 0
        )
        SELECT
          workspace_id,
          SUM(usage_quantity * price_per_dbu) as workspace_spend,
          {threshold_amount} as threshold,
          COUNT(DISTINCT usage_date) as days_active
        FROM usage_with_price
        GROUP BY workspace_id
        HAVING SUM(usage_quantity * price_per_dbu) > {threshold_amount}
        ORDER BY workspace_spend DESC
        LIMIT 10
        """

        query = w.queries.create(
            query=sql.CreateQueryRequestQuery(
                display_name=f"{alert_name} - Query",
                warehouse_id=warehouse_id,
                description=f"Detects workspaces with spend exceeding ${threshold_amount:,.0f} (7-day rolling)",
                query_text=query_text
            )
        )

        logger.info(f"Created query for workspace alert: {query.id}")

        alert = w.alerts.create(
            alert=sql.CreateAlertRequestAlert(
                display_name=alert_name,
                query_id=query.id,
                condition=sql.AlertCondition(
                    operand=sql.AlertConditionOperand(
                        column=sql.AlertOperandColumn(name="workspace_spend")
                    ),
                    op=sql.AlertOperator.GREATER_THAN,
                    threshold=sql.AlertConditionThreshold(
                        value=sql.AlertOperandValue(double_value=threshold_amount)
                    )
                )
            )
        )

        logger.info(f"Created workspace cost alert: {alert.id}")

        return {
            "success": True,
            "alert_id": alert.id,
            "query_id": query.id,
            "alert_name": alert_name
        }

    except Exception as e:
        logger.error(f"Failed to create workspace alert: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def _list_all_alerts(w: WorkspaceClient) -> list | None:
    """List all alerts from the workspace. Returns None on failure."""
    try:
        return list(w.alerts.list())
    except Exception as e:
        logger.warning(f"Failed to list alerts: {e}")
        return None


def _deduplicate_alerts(w: WorkspaceClient, all_alerts: list, target_names: list[str]) -> int:
    """
    Remove duplicate alerts, keeping only one per base name.

    Databricks auto-renames duplicates with suffixes like " (1)", " (2)", etc.
    This matches on base name prefix so those suffixed copies get cleaned up too.

    Returns the number of duplicates removed.
    """
    removed = 0
    for name in target_names:
        # Match exact name AND auto-suffixed variants like "Name (1)", "Name (2)"
        matches = [
            a for a in all_alerts
            if a.display_name and (
                a.display_name == name or a.display_name.startswith(f"{name} (")
            )
        ]
        if len(matches) <= 1:
            continue
        # Sort by create_time if available, otherwise keep first match
        matches.sort(key=lambda a: str(getattr(a, "create_time", "") or ""))
        # Keep the oldest one, delete the rest
        for dup in matches[1:]:
            try:
                w.alerts.delete(dup.id)
                logger.info(f"Removed duplicate alert: {dup.display_name} ({dup.id})")
                if dup.query_id:
                    try:
                        w.queries.delete(dup.query_id)
                    except Exception:
                        pass
                removed += 1
            except Exception as e:
                logger.warning(f"Failed to delete duplicate alert {dup.id}: {e}")
    return removed


def create_default_cost_alerts(
    spike_threshold_percent: float = 20.0,
    daily_threshold_amount: float = 50000.0,
    workspace_threshold_amount: float = 10000.0
) -> dict[str, Any]:
    """
    Create all default cost monitoring alerts (idempotent).

    Lists all alerts once, creates any that are missing, and removes duplicates.
    Safe to call from multiple workers — duplicates are cleaned up automatically.
    """
    results: dict[str, list] = {
        "created": [],
        "skipped": [],
        "errors": []
    }

    try:
        w = get_workspace_client()
        warehouse_id = get_sql_warehouse_id()

        logger.info("Creating default cost monitoring alerts...")

        alert_configs = [
            ("Cost Observability - Daily Spend Spike", create_cost_spike_alert, [spike_threshold_percent]),
            ("Cost Observability - Daily Spend Threshold", create_daily_threshold_alert, [daily_threshold_amount]),
            ("Cost Observability - High Workspace Spend", create_workspace_cost_alert, [workspace_threshold_amount]),
        ]

        target_names = [name for name, _, _ in alert_configs]

        # Fetch ALL alerts once upfront
        all_alerts = _list_all_alerts(w)
        if all_alerts is None:
            logger.warning("Cannot list alerts — skipping all alert creation to avoid duplicates")
            results["errors"].append({"error": "Failed to list existing alerts"})
            return results

        existing_names = {a.display_name for a in all_alerts if a.display_name}

        def _alert_exists(name: str) -> bool:
            """Check if alert exists by exact name or auto-suffixed variant."""
            if name in existing_names:
                return True
            return any(n.startswith(f"{name} (") for n in existing_names)

        # Create only missing alerts
        for alert_name, create_fn, args in alert_configs:
            if _alert_exists(alert_name):
                results["skipped"].append(alert_name)
            else:
                result = create_fn(w, warehouse_id, *args, alert_name)
                if result["success"]:
                    results["created"].append(alert_name)
                else:
                    results["errors"].append({
                        "alert": alert_name,
                        "error": result.get("error")
                    })

        # Always deduplicate on startup to clean up prior duplicates
        fresh_alerts = _list_all_alerts(w)
        if fresh_alerts:
            removed = _deduplicate_alerts(w, fresh_alerts, target_names)
            if removed > 0:
                logger.info(f"Cleaned up {removed} duplicate alert(s)")
                # Invalidate cache so list_cost_alerts returns fresh data
                if _ALERTS_CACHE_KEY in _alerts_cache:
                    del _alerts_cache[_ALERTS_CACHE_KEY]

        logger.info(f"Alert setup complete: {len(results['created'])} created, {len(results['skipped'])} skipped, {len(results['errors'])} errors")

        return results

    except Exception as e:
        logger.error(f"Failed to create default alerts: {e}")
        return {
            "created": [],
            "skipped": [],
            "errors": [{"error": str(e)}]
        }


def delete_cost_alert(alert_id: str) -> dict[str, Any]:
    """
    Delete a cost observability alert by ID.

    This also deletes the associated query.

    Args:
        alert_id: ID of the alert to delete

    Returns:
        Dictionary with success status and details
    """
    try:
        w = get_workspace_client()

        # First, get the alert to find its query_id
        alert = w.alerts.get(alert_id)
        query_id = alert.query_id

        # Delete the alert first
        w.alerts.delete(alert_id)
        logger.info(f"Deleted alert: {alert_id}")

        # Then delete the associated query
        if query_id:
            try:
                w.queries.delete(query_id)
                logger.info(f"Deleted associated query: {query_id}")
            except Exception as e:
                logger.warning(f"Failed to delete associated query {query_id}: {e}")

        # Clear the cache so next list call gets fresh data
        if _ALERTS_CACHE_KEY in _alerts_cache:
            del _alerts_cache[_ALERTS_CACHE_KEY]

        return {
            "success": True,
            "alert_id": alert_id,
            "query_id": query_id,
            "message": "Alert deleted successfully"
        }

    except Exception as e:
        logger.error(f"Failed to delete alert {alert_id}: {e}")
        return {
            "success": False,
            "error": str(e)
        }


# Cache for alerts list (5 minute TTL - alerts don't change often)
_alerts_cache: TTLCache = TTLCache(maxsize=10, ttl=300)
_ALERTS_CACHE_KEY = "cost_alerts"


def create_custom_alert(
    name: str,
    alert_type: str,
    threshold_amount: float | None = None,
    spike_percent: float | None = None
) -> dict[str, Any]:
    """
    Create a custom cost monitoring alert.

    Args:
        name: Display name for the alert
        alert_type: Either "threshold" or "spike"
        threshold_amount: Dollar threshold for threshold-type alerts
        spike_percent: Percent change threshold for spike-type alerts

    Returns:
        Dictionary with alert_id and status
    """
    try:
        w = get_workspace_client()
        warehouse_id = get_sql_warehouse_id()

        # Check if alert with this name already exists
        existing = _list_all_alerts(w)
        if existing is not None and any(a.display_name == name for a in existing):
            return {
                "success": False,
                "error": f"Alert with name '{name}' already exists"
            }

        if alert_type == "threshold":
            if threshold_amount is None:
                return {
                    "success": False,
                    "error": "threshold_amount is required for threshold alerts"
                }
            result = create_daily_threshold_alert(w, warehouse_id, threshold_amount, name)
        elif alert_type == "spike":
            if spike_percent is None:
                spike_percent = 20.0  # Default to 20%
            result = create_cost_spike_alert(w, warehouse_id, spike_percent, name)
        else:
            return {
                "success": False,
                "error": f"Unknown alert type: {alert_type}. Must be 'threshold' or 'spike'"
            }

        # Clear the cache so the new alert shows up
        if _ALERTS_CACHE_KEY in _alerts_cache:
            del _alerts_cache[_ALERTS_CACHE_KEY]

        return result

    except Exception as e:
        logger.error(f"Failed to create custom alert: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def list_cost_alerts() -> list[dict[str, Any]]:
    """
    List all cost observability alerts.

    Results are cached for 5 minutes to avoid slow SDK calls on every request.

    Returns:
        List of alert dictionaries with id, name, and status
    """
    # Check cache first
    if _ALERTS_CACHE_KEY in _alerts_cache:
        logger.info("Returning cached alerts list")
        return _alerts_cache[_ALERTS_CACHE_KEY]

    try:
        start_time = time.time()
        w = get_workspace_client()

        # List all alerts and filter for cost observability ones
        all_alerts = list(w.alerts.list())
        logger.info(f"Total alerts found: {len(all_alerts)}")

        cost_alerts = [
            {
                "id": alert.id,
                "name": alert.display_name,
                "query_id": alert.query_id,
                "parent": getattr(alert, "parent", ""),
                "state": str(getattr(alert, "state", "ACTIVE"))
            }
            for alert in all_alerts
            if alert.display_name and "Cost Observability" in alert.display_name
        ]

        # Cache the result
        _alerts_cache[_ALERTS_CACHE_KEY] = cost_alerts
        elapsed = time.time() - start_time
        logger.info(f"Cost observability alerts found: {len(cost_alerts)} (took {elapsed:.2f}s)")
        return cost_alerts

    except Exception as e:
        logger.error(f"Failed to list alerts: {e}")
        return []
