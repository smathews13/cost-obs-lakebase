"""Email service for sending alert notifications."""

import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

logger = logging.getLogger(__name__)


def get_smtp_config() -> dict[str, Any]:
    """Get SMTP configuration from environment variables."""
    return {
        "host": os.getenv("SMTP_HOST", "smtp.gmail.com"),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "username": os.getenv("SMTP_USERNAME"),
        "password": os.getenv("SMTP_PASSWORD"),
        "from_email": os.getenv("SMTP_FROM_EMAIL"),
        "from_name": os.getenv("SMTP_FROM_NAME", "Cost Observability & Control"),
    }


def send_alert_email(
    to_email: str,
    subject: str,
    html_body: str,
    to_name: str | None = None
) -> dict[str, Any]:
    """
    Send an alert email.

    Args:
        to_email: Recipient email address
        subject: Email subject line
        html_body: HTML email body
        to_name: Recipient name (optional)

    Returns:
        Dictionary with success status and message
    """
    config = get_smtp_config()

    # Check if SMTP is configured
    if not config["username"] or not config["password"] or not config["from_email"]:
        logger.warning("SMTP not configured - email not sent")
        return {
            "success": False,
            "error": "SMTP not configured. Set SMTP_USERNAME, SMTP_PASSWORD, and SMTP_FROM_EMAIL environment variables."
        }

    try:
        # Create message
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{config['from_name']} <{config['from_email']}>"
        msg["To"] = f"{to_name} <{to_email}>" if to_name else to_email

        # Attach HTML body
        html_part = MIMEText(html_body, "html")
        msg.attach(html_part)

        # Send email
        with smtplib.SMTP(config["host"], config["port"]) as server:
            server.starttls()
            server.login(config["username"], config["password"])
            server.send_message(msg)

        logger.info(f"Alert email sent to {to_email}")
        return {
            "success": True,
            "message": f"Email sent to {to_email}"
        }

    except smtplib.SMTPAuthenticationError:
        logger.error("SMTP authentication failed")
        return {
            "success": False,
            "error": "SMTP authentication failed. Check SMTP_USERNAME and SMTP_PASSWORD."
        }
    except smtplib.SMTPException as e:
        logger.error(f"SMTP error: {e}")
        return {
            "success": False,
            "error": f"Failed to send email: {str(e)}"
        }
    except Exception as e:
        logger.error(f"Unexpected error sending email: {e}")
        return {
            "success": False,
            "error": f"Unexpected error: {str(e)}"
        }


def send_alert_digest(
    to_email: str,
    alerts: list[dict[str, Any]],
    to_name: str | None = None
) -> dict[str, Any]:
    """
    Send a digest email with multiple alerts.

    Args:
        to_email: Recipient email address
        alerts: List of alert dictionaries
        to_name: Recipient name (optional)

    Returns:
        Dictionary with success status and message
    """
    if not alerts:
        return {
            "success": False,
            "error": "No alerts to send"
        }

    # Build digest HTML
    html = """
    <html>
    <body style="font-family: Arial, sans-serif;">
        <h1 style="color: #333;">Cost Observability Alert Digest</h1>
        <p>You have {count} new cost alert{plural} to review:</p>
        <hr style="border: 1px solid #ddd; margin: 20px 0;">
    """.format(
        count=len(alerts),
        plural="s" if len(alerts) != 1 else ""
    )

    # Add each alert
    for i, alert in enumerate(alerts, 1):
        alert_type = alert.get("alert_type", "unknown")
        severity = alert.get("severity", "medium")
        color = "red" if severity == "high" else "orange"

        html += f"""
        <div style="margin: 20px 0; padding: 15px; border-left: 4px solid {color}; background-color: #f9f9f9;">
            <h3 style="margin: 0 0 10px 0; color: {color};">Alert #{i}: {alert_type.title()}</h3>
            <p style="margin: 5px 0;"><strong>Date:</strong> {alert.get('usage_date', 'N/A')}</p>
            <p style="margin: 5px 0;"><strong>Daily Spend:</strong> ${alert.get('daily_spend', 0):,.2f}</p>
        """

        if alert_type == "spike":
            change = alert.get("change_percent", 0)
            direction = "increased" if change > 0 else "decreased"
            html += f"""
            <p style="margin: 5px 0;"><strong>Change:</strong> {abs(change):.1f}% {direction}</p>
            """
        elif alert_type == "threshold":
            html += f"""
            <p style="margin: 5px 0;"><strong>Threshold:</strong> ${alert.get('threshold', 0):,.2f}</p>
            <p style="margin: 5px 0;"><strong>Excess:</strong> ${alert.get('excess_amount', 0):,.2f}</p>
            """

        html += """
        </div>
        """

    html += """
        <hr style="border: 1px solid #ddd; margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">
            This is an automated alert from Cost Observability & Control.
            Please review your Databricks workspace activity for these dates.
        </p>
    </body>
    </html>
    """

    subject = f"Cost Alert Digest: {len(alerts)} New Alert{'s' if len(alerts) != 1 else ''}"
    return send_alert_email(to_email, subject, html, to_name)


def test_smtp_connection() -> dict[str, Any]:
    """
    Test SMTP connection and configuration.

    Returns:
        Dictionary with success status and details
    """
    config = get_smtp_config()

    if not config["username"] or not config["password"]:
        return {
            "success": False,
            "error": "SMTP credentials not configured",
            "config": {
                "host": config["host"],
                "port": config["port"],
                "username_set": bool(config["username"]),
                "password_set": bool(config["password"]),
                "from_email_set": bool(config["from_email"]),
            }
        }

    try:
        with smtplib.SMTP(config["host"], config["port"]) as server:
            server.starttls()
            server.login(config["username"], config["password"])

        return {
            "success": True,
            "message": "SMTP connection successful",
            "config": {
                "host": config["host"],
                "port": config["port"],
                "from_email": config["from_email"],
            }
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "success": False,
            "error": "SMTP authentication failed",
            "config": {
                "host": config["host"],
                "port": config["port"],
            }
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Connection failed: {str(e)}",
            "config": {
                "host": config["host"],
                "port": config["port"],
            }
        }
