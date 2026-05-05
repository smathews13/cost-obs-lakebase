"""Alerting and anomaly detection for cost observability."""

import logging
from datetime import date, timedelta
from typing import Any

from server.db import execute_query, execute_queries_parallel

logger = logging.getLogger(__name__)


def detect_spend_spikes(
    threshold_percent: float = 20.0,
    days_back: int = 7
) -> list[dict[str, Any]]:
    """
    Detect days where spend spiked above threshold.

    Args:
        threshold_percent: Minimum percent change to flag as spike
        days_back: How many days to look back

    Returns:
        List of spike events with date, amounts, and percent change
    """
    end_date = date.today()
    start_date = end_date - timedelta(days=days_back)

    query = """
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
      usage_date,
      daily_spend,
      prev_day_spend,
      (daily_spend - prev_day_spend) as change_amount,
      ((daily_spend - prev_day_spend) / prev_day_spend * 100) as change_percent
    FROM with_prev
    WHERE prev_day_spend IS NOT NULL
      AND ABS((daily_spend - prev_day_spend) / prev_day_spend * 100) >= :threshold
    ORDER BY ABS(change_percent) DESC
    """

    params = {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "threshold": threshold_percent
    }

    results = execute_query(query, params)

    spikes = []
    for row in results:
        spikes.append({
            "usage_date": str(row["usage_date"]),
            "daily_spend": float(row["daily_spend"]),
            "prev_day_spend": float(row["prev_day_spend"]),
            "change_amount": float(row["change_amount"]),
            "change_percent": float(row["change_percent"]),
            "alert_type": "spike",
            "severity": "high" if abs(row["change_percent"]) > 50 else "medium"
        })

    return spikes


def detect_threshold_breaches(
    threshold_amount: float,
    days_back: int = 7
) -> list[dict[str, Any]]:
    """
    Detect days where spend exceeded a threshold.

    Args:
        threshold_amount: Dollar amount threshold
        days_back: How many days to look back

    Returns:
        List of breach events
    """
    end_date = date.today()
    start_date = end_date - timedelta(days=days_back)

    query = """
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
    )
    SELECT
      usage_date,
      SUM(usage_quantity * price_per_dbu) as daily_spend
    FROM usage_with_price
    GROUP BY usage_date
    HAVING SUM(usage_quantity * price_per_dbu) > :threshold
    ORDER BY daily_spend DESC
    """

    params = {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "threshold": threshold_amount
    }

    results = execute_query(query, params)

    breaches = []
    for row in results:
        breaches.append({
            "usage_date": str(row["usage_date"]),
            "daily_spend": float(row["daily_spend"]),
            "threshold": threshold_amount,
            "excess_amount": float(row["daily_spend"]) - threshold_amount,
            "alert_type": "threshold",
            "severity": "high"
        })

    return breaches


def get_recent_alerts(days_back: int = 7) -> dict[str, Any]:
    """
    Get all recent alerts (spikes and threshold breaches).

    Args:
        days_back: How many days to look back

    Returns:
        Dictionary with alerts grouped by type
    """
    spikes = detect_spend_spikes(threshold_percent=15.0, days_back=days_back)

    return {
        "spikes": spikes,
        "total_alerts": len(spikes),
        "date_range": {
            "start": (date.today() - timedelta(days=days_back)).isoformat(),
            "end": date.today().isoformat()
        }
    }


def _build_breakdown_query(dimension: str, dimension_filter: str = "") -> str:
    """Build a breakdown query for a given dimension (sku_name, cluster_id, workspace_id)."""
    select_expr = dimension
    if dimension == "cluster_id":
        select_expr = "u.usage_metadata.cluster_id as cluster_id"
        dimension_filter = "AND u.usage_metadata.cluster_id IS NOT NULL"
    elif dimension == "workspace_id":
        select_expr = "u.workspace_id"
    else:
        select_expr = f"u.{dimension}"

    return f"""
    WITH usage_with_price AS (
      SELECT
        {select_expr},
        u.usage_quantity,
        COALESCE(p.pricing.default, 0) as price_per_dbu
      FROM system.billing.usage u
      LEFT JOIN system.billing.list_prices p
        ON u.sku_name = p.sku_name
        AND u.cloud = p.cloud
        AND p.price_end_time IS NULL
      WHERE u.usage_date = :usage_date
        AND u.usage_quantity > 0
        {dimension_filter}
    )
    SELECT
      {dimension},
      SUM(usage_quantity) as dbus,
      SUM(usage_quantity * price_per_dbu) as spend
    FROM usage_with_price
    GROUP BY {dimension}
    ORDER BY spend DESC
    LIMIT 10
    """


def get_alert_details(usage_date: str, prev_usage_date: str | None = None) -> dict[str, Any]:
    """
    Get detailed breakdown for a specific date's spend.

    Args:
        usage_date: Date to analyze (YYYY-MM-DD format)
        prev_usage_date: Optional previous date for comparison (YYYY-MM-DD format)

    Returns:
        Dictionary with detailed breakdown by SKU, cluster, and workspace.
        If prev_usage_date is provided, includes prev_skus, prev_clusters, prev_workspaces.
    """
    sku_query = _build_breakdown_query("sku_name")
    cluster_query = _build_breakdown_query("cluster_id")
    workspace_query = _build_breakdown_query("workspace_id")

    params = {"usage_date": usage_date}
    prev_params = {"usage_date": prev_usage_date} if prev_usage_date else None

    try:
        # Build query list — current date always, previous date if requested
        queries = [
            ("skus", lambda: execute_query(sku_query, params)),
            ("clusters", lambda: execute_query(cluster_query, params)),
            ("workspaces", lambda: execute_query(workspace_query, params)),
        ]
        if prev_params:
            queries.extend([
                ("prev_skus", lambda: execute_query(sku_query, prev_params)),
                ("prev_clusters", lambda: execute_query(cluster_query, prev_params)),
                ("prev_workspaces", lambda: execute_query(workspace_query, prev_params)),
            ])

        query_results = execute_queries_parallel(queries)

        sku_results = query_results.get("skus") or []
        cluster_results = query_results.get("clusters") or []
        workspace_results = query_results.get("workspaces") or []

        result: dict[str, Any] = {
            "usage_date": usage_date,
            "skus": [
                {
                    "sku_name": row["sku_name"],
                    "dbus": float(row["dbus"]),
                    "spend": float(row["spend"])
                }
                for row in sku_results
            ],
            "clusters": [
                {
                    "cluster_id": row["cluster_id"],
                    "dbus": float(row["dbus"]),
                    "spend": float(row["spend"])
                }
                for row in cluster_results
            ],
            "workspaces": [
                {
                    "workspace_id": str(row["workspace_id"]),
                    "dbus": float(row["dbus"]),
                    "spend": float(row["spend"])
                }
                for row in workspace_results
            ]
        }

        if prev_params:
            prev_sku_results = query_results.get("prev_skus") or []
            prev_cluster_results = query_results.get("prev_clusters") or []
            prev_workspace_results = query_results.get("prev_workspaces") or []
            result["prev_usage_date"] = prev_usage_date
            result["prev_skus"] = [
                {"sku_name": row["sku_name"], "dbus": float(row["dbus"]), "spend": float(row["spend"])}
                for row in prev_sku_results
            ]
            result["prev_clusters"] = [
                {"cluster_id": row["cluster_id"], "dbus": float(row["dbus"]), "spend": float(row["spend"])}
                for row in prev_cluster_results
            ]
            result["prev_workspaces"] = [
                {"workspace_id": str(row["workspace_id"]), "dbus": float(row["dbus"]), "spend": float(row["spend"])}
                for row in prev_workspace_results
            ]

        return result
    except Exception as e:
        logger.error(f"Error getting alert details for {usage_date}: {e}")
        return {
            "usage_date": usage_date,
            "skus": [],
            "clusters": [],
            "workspaces": [],
            "error": str(e)
        }


def format_alert_email(alert: dict[str, Any]) -> str:
    """
    Format an alert as an email body.

    Args:
        alert: Alert dictionary

    Returns:
        Formatted email body (HTML)
    """
    if alert["alert_type"] == "spike":
        direction = "increased" if alert["change_amount"] > 0 else "decreased"
        color = "red" if alert["change_amount"] > 0 else "green"

        return f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: {color};">Cost Spike Alert</h2>
            <p><strong>Date:</strong> {alert['usage_date']}</p>
            <p><strong>Daily Spend:</strong> ${alert['daily_spend']:,.2f}</p>
            <p><strong>Previous Day:</strong> ${alert['prev_day_spend']:,.2f}</p>
            <p><strong>Change:</strong> ${abs(alert['change_amount']):,.2f} ({abs(alert['change_percent']):.1f}% {direction})</p>
            <p><strong>Severity:</strong> {alert['severity'].upper()}</p>

            <p style="margin-top: 20px;">
                Your Databricks spend {direction} by {abs(alert['change_percent']):.1f}% on {alert['usage_date']}.
            </p>

            <p style="margin-top: 20px; padding: 10px; background-color: #f0f0f0; border-left: 4px solid {color};">
                <strong>Recommended Action:</strong> Review your workspace activity and pipeline runs for this date to identify the cause of this change.
            </p>
        </body>
        </html>
        """

    elif alert["alert_type"] == "threshold":
        return f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: red;">Threshold Breach Alert</h2>
            <p><strong>Date:</strong> {alert['usage_date']}</p>
            <p><strong>Daily Spend:</strong> ${alert['daily_spend']:,.2f}</p>
            <p><strong>Threshold:</strong> ${alert['threshold']:,.2f}</p>
            <p><strong>Excess:</strong> ${alert['excess_amount']:,.2f}</p>
            <p><strong>Severity:</strong> {alert['severity'].upper()}</p>

            <p style="margin-top: 20px;">
                Your Databricks spend exceeded the configured threshold of ${alert['threshold']:,.2f} on {alert['usage_date']}.
            </p>

            <p style="margin-top: 20px; padding: 10px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <strong>Recommended Action:</strong> Review resource usage and consider implementing budget policies or scaling down non-critical workloads.
            </p>
        </body>
        </html>
        """

    return "Unknown alert type"
