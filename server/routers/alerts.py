"""Alerts API endpoints."""

import logging
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

from server.alerting import (
    detect_spend_spikes,
    detect_threshold_breaches,
    get_recent_alerts,
    get_alert_details,
    format_alert_email
)
from server.email_service import (
    send_alert_email,
    send_alert_digest,
    test_smtp_connection
)
from server.alert_manager import (
    create_default_cost_alerts,
    create_custom_alert,
    list_cost_alerts,
    delete_cost_alert
)

router = APIRouter()
logger = logging.getLogger(__name__)


class SendAlertRequest(BaseModel):
    """Request model for sending an alert email."""
    to_email: str
    alert_data: dict[str, Any]
    to_name: str | None = None


class SendDigestRequest(BaseModel):
    """Request model for sending alert digest email."""
    to_email: str
    to_name: str | None = None
    days_back: int = 7


class CreateCustomAlertRequest(BaseModel):
    """Request model for creating a custom alert."""
    name: str
    alert_type: str  # "threshold" or "spike"
    threshold_amount: float | None = None
    spike_percent: float | None = None


@router.get("/recent")
async def get_recent_alerts_endpoint(
    days_back: int = Query(7, ge=1, le=90, description="Days to look back")
) -> dict[str, Any]:
    """Get recent alerts (spikes and anomalies)."""
    try:
        alerts = get_recent_alerts(days_back=days_back)
        return alerts
    except Exception as e:
        logger.error(f"Error getting recent alerts: {e}")
        return {"error": str(e), "spikes": [], "total_alerts": 0}


@router.get("/details/{usage_date}")
async def get_alert_details_endpoint(
    usage_date: str,
    prev_usage_date: str | None = Query(None, description="Previous date for comparison (YYYY-MM-DD)")
) -> dict[str, Any]:
    """Get detailed breakdown for a specific date's spend.

    Returns breakdown by SKU, cluster, and workspace.
    Optionally includes previous day data for comparison.
    """
    try:
        details = get_alert_details(usage_date, prev_usage_date=prev_usage_date)
        return details
    except Exception as e:
        logger.error(f"Error getting alert details: {e}")
        return {
            "usage_date": usage_date,
            "skus": [],
            "clusters": [],
            "workspaces": [],
            "error": str(e)
        }


@router.get("/spikes")
async def get_spend_spikes(
    threshold_percent: float = Query(20.0, ge=5.0, le=100.0, description="Minimum percent change"),
    days_back: int = Query(7, ge=1, le=90, description="Days to look back")
) -> dict[str, Any]:
    """Detect spend spikes above threshold."""
    try:
        spikes = detect_spend_spikes(
            threshold_percent=threshold_percent,
            days_back=days_back
        )
        return {
            "spikes": spikes,
            "count": len(spikes),
            "threshold_percent": threshold_percent
        }
    except Exception as e:
        logger.error(f"Error detecting spikes: {e}")
        return {"error": str(e), "spikes": [], "count": 0}


@router.get("/threshold-breaches")
async def get_threshold_breaches(
    threshold_amount: float = Query(..., ge=0, description="Dollar threshold"),
    days_back: int = Query(7, ge=1, le=90, description="Days to look back")
) -> dict[str, Any]:
    """Detect days where spend exceeded threshold."""
    try:
        breaches = detect_threshold_breaches(
            threshold_amount=threshold_amount,
            days_back=days_back
        )
        return {
            "breaches": breaches,
            "count": len(breaches),
            "threshold_amount": threshold_amount
        }
    except Exception as e:
        logger.error(f"Error detecting threshold breaches: {e}")
        return {"error": str(e), "breaches": [], "count": 0}


@router.post("/test-email-format")
async def test_alert_email(alert_data: dict[str, Any]) -> dict[str, Any]:
    """
    Test alert email formatting.

    Accepts an alert dictionary and returns the formatted HTML email.
    """
    try:
        html = format_alert_email(alert_data)
        return {
            "success": True,
            "html": html
        }
    except Exception as e:
        logger.error(f"Error formatting email: {e}")
        return {
            "success": False,
            "error": str(e)
        }


@router.post("/send-alert")
async def send_alert(request: SendAlertRequest) -> dict[str, Any]:
    """
    Send an alert email to a recipient.

    Formats the alert and sends it via SMTP.
    """
    try:
        # Format the alert
        html = format_alert_email(request.alert_data)

        # Create subject line
        alert_type = request.alert_data.get("alert_type", "alert")
        usage_date = request.alert_data.get("usage_date", "unknown")
        subject = f"Cost Alert: {alert_type.title()} on {usage_date}"

        # Send email
        result = send_alert_email(
            to_email=request.to_email,
            subject=subject,
            html_body=html,
            to_name=request.to_name
        )

        return result
    except Exception as e:
        logger.error(f"Error sending alert email: {e}")
        return {
            "success": False,
            "error": str(e)
        }


@router.post("/send-digest")
async def send_digest(request: SendDigestRequest) -> dict[str, Any]:
    """
    Send a digest email with recent alerts.

    Fetches recent alerts and sends them in a single email.
    """
    try:
        # Get recent alerts
        alerts_data = get_recent_alerts(days_back=request.days_back)
        alerts = alerts_data.get("spikes", [])

        if not alerts:
            return {
                "success": False,
                "error": "No alerts to send"
            }

        # Send digest
        result = send_alert_digest(
            to_email=request.to_email,
            alerts=alerts,
            to_name=request.to_name
        )

        return {
            **result,
            "alert_count": len(alerts)
        }
    except Exception as e:
        logger.error(f"Error sending digest email: {e}")
        return {
            "success": False,
            "error": str(e)
        }


@router.get("/test-smtp")
async def test_smtp() -> dict[str, Any]:
    """
    Test SMTP connection and configuration.

    Returns connection status and configuration details.
    """
    try:
        result = test_smtp_connection()
        return result
    except Exception as e:
        logger.error(f"Error testing SMTP: {e}")
        return {
            "success": False,
            "error": str(e)
        }


@router.post("/setup-databricks-alerts")
async def setup_databricks_alerts(
    spike_threshold_percent: float = Query(20.0, ge=5.0, le=100.0, description="Percent change threshold for spike alerts"),
    daily_threshold_amount: float = Query(50000.0, ge=0, description="Dollar threshold for daily spend alerts"),
    workspace_threshold_amount: float = Query(10000.0, ge=0, description="Dollar threshold for workspace alerts")
) -> dict[str, Any]:
    """
    Create default Databricks SQL Alerts for cost monitoring.

    This creates native Databricks SQL Alerts that run queries against
    billing tables and send notifications when conditions are met.

    The alerts created are:
    1. Daily Spend Spike - Triggers when day-over-day spend changes by threshold %
    2. Daily Spend Threshold - Triggers when daily spend exceeds dollar threshold
    3. High Workspace Spend - Triggers when workspace 7-day spend exceeds threshold

    Returns:
        Dictionary with lists of created, skipped, and error alerts
    """
    try:
        results = create_default_cost_alerts(
            spike_threshold_percent=spike_threshold_percent,
            daily_threshold_amount=daily_threshold_amount,
            workspace_threshold_amount=workspace_threshold_amount
        )
        return results
    except Exception as e:
        logger.error(f"Error setting up Databricks alerts: {e}")
        return {
            "created": [],
            "skipped": [],
            "errors": [{"error": str(e)}]
        }


@router.post("/create-custom-alert")
async def create_custom_alert_endpoint(request: CreateCustomAlertRequest) -> dict[str, Any]:
    """
    Create a custom Databricks SQL Alert for cost monitoring.

    This creates a native Databricks SQL Alert with custom name and threshold.

    Args:
        request: Custom alert configuration

    Returns:
        Dictionary with alert_id and status
    """
    from fastapi import HTTPException
    try:
        result = create_custom_alert(
            name=request.name,
            alert_type=request.alert_type,
            threshold_amount=request.threshold_amount,
            spike_percent=request.spike_percent
        )
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to create alert"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating custom alert: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/databricks-alerts")
async def get_databricks_alerts() -> dict[str, Any]:
    """
    List all Cost Observability Databricks SQL Alerts.

    Returns:
        Dictionary with list of alerts and their details
    """
    try:
        from server.db import get_host_url
        alerts = list_cost_alerts()
        return {
            "alerts": alerts,
            "count": len(alerts),
            "databricks_host": get_host_url()
        }
    except Exception as e:
        logger.error(f"Error listing Databricks alerts: {e}")
        return {
            "alerts": [],
            "count": 0,
            "error": str(e)
        }


@router.delete("/databricks-alerts/{alert_id}")
async def delete_databricks_alert(alert_id: str) -> dict[str, Any]:
    """
    Delete a Cost Observability Databricks SQL Alert by ID.

    This will also delete the associated query.

    Args:
        alert_id: ID of the alert to delete

    Returns:
        Dictionary with deletion status
    """
    from fastapi import HTTPException
    try:
        result = delete_cost_alert(alert_id)
        if not result.get("success"):
            raise HTTPException(status_code=500, detail=result.get("error", "Failed to delete alert"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting Databricks alert {alert_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
