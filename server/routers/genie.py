"""Genie API endpoints for natural language queries about cost data."""

import asyncio
import json
import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.db import get_workspace_client

logger = logging.getLogger(__name__)

router = APIRouter()


def _load_genie_space_id_from_settings() -> str:
    """Load Genie Space ID from settings file (created during setup wizard)."""
    settings_file = os.path.join(os.path.dirname(__file__), "..", "..", ".settings", "genie_settings.json")
    settings_file = os.path.normpath(settings_file)
    if os.path.exists(settings_file):
        try:
            with open(settings_file, "r") as f:
                return json.load(f).get("space_id", "")
        except Exception:
            pass
    return ""


def get_genie_config() -> dict[str, str]:
    """Get Genie Space configuration from environment."""
    # Try env var first (local dev), fall back to workspace client (Databricks App)
    host = os.getenv("DATABRICKS_HOST", "")
    token = os.getenv("DATABRICKS_TOKEN", "")
    space_id = os.getenv("GENIE_SPACE_ID", "")

    # Fall back to settings file (created during setup wizard)
    if not space_id:
        space_id = _load_genie_space_id_from_settings()

    if not token or not host:
        try:
            w = get_workspace_client()
            if not host:
                host = w.config.host or ""
            if not token:
                # Get fresh token from workspace client auth
                header = w.config.authenticate()
                token = header.get("Authorization", "").replace("Bearer ", "")
        except Exception as e:
            logger.warning("Failed to get token from workspace client: %s", e)

    if host and not host.startswith("http"):
        host = f"https://{host}"

    return {
        "host": host,
        "token": token,
        "space_id": space_id,
    }


class ChatMessage(BaseModel):
    """Chat message request."""

    message: str
    conversation_id: str | None = None


class SpendAnomalyAnalysis(BaseModel):
    """Request to analyze a spend anomaly."""

    usage_date: str
    daily_spend: float
    prev_day_spend: float
    change_amount: float
    change_percent: float


class GenieResponse(BaseModel):
    """Genie response model."""

    conversation_id: str
    message_id: str
    status: str
    response: str | None = None
    sql: str | None = None
    data: list[dict[str, Any]] | None = None
    error: str | None = None


@router.get("/config")
async def get_config() -> dict[str, Any]:
    """Check if Genie is configured."""
    config = get_genie_config()
    return {
        "configured": bool(config["space_id"]),
        "space_id": config["space_id"] if config["space_id"] else None,
        "host": config["host"] if config["host"] else None,
    }


@router.post("/chat")
async def chat(request: ChatMessage) -> GenieResponse:
    """Send a message to Genie and get a response."""
    config = get_genie_config()

    if not config["space_id"]:
        raise HTTPException(
            status_code=400,
            detail="Genie Space ID not configured. Set GENIE_SPACE_ID environment variable.",
        )

    if not config["token"]:
        raise HTTPException(
            status_code=400,
            detail="Databricks token not configured.",
        )

    headers = {
        "Authorization": f"Bearer {config['token']}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            # Start a new conversation or continue existing one
            if request.conversation_id:
                # Continue existing conversation
                url = f"{config['host']}/api/2.0/genie/spaces/{config['space_id']}/conversations/{request.conversation_id}/messages"
                payload = {"content": request.message}
            else:
                # Start new conversation
                url = f"{config['host']}/api/2.0/genie/spaces/{config['space_id']}/start-conversation"
                payload = {"content": request.message}

            logger.info(f"Sending message to: {url}")
            logger.debug(f"Payload: {payload}")

            response = await client.post(url, headers=headers, json=payload)

            logger.info(f"Response status: {response.status_code}")

            if response.status_code != 200:
                error_detail = response.text
                logger.error(f"Error response: {error_detail}")
                return GenieResponse(
                    conversation_id=request.conversation_id or "",
                    message_id="",
                    status="error",
                    error=f"Genie API error ({response.status_code}): {error_detail}",
                )

            result = response.json()
            logger.debug(f"Initial result: {result}")
            conversation_id = result.get("conversation_id", request.conversation_id)
            message_id = result.get("message_id", "")

            # Poll for completion
            poll_url = f"{config['host']}/api/2.0/genie/spaces/{config['space_id']}/conversations/{conversation_id}/messages/{message_id}"

            max_attempts = 300  # 300 seconds max (5 minutes)
            for attempt in range(max_attempts):
                poll_response = await client.get(poll_url, headers=headers)

                if poll_response.status_code != 200:
                    error_detail = poll_response.text
                    return GenieResponse(
                        conversation_id=conversation_id,
                        message_id=message_id,
                        status="error",
                        error=f"Poll failed ({poll_response.status_code}): {error_detail}",
                    )

                poll_result = poll_response.json()
                status = poll_result.get("status", "")

                # Log status for debugging
                logger.debug(f"Poll {attempt}: status={status}")

                if status == "COMPLETED":
                    # Extract the response
                    attachments = poll_result.get("attachments", [])
                    logger.debug(f"Found {len(attachments)} attachments")
                    text_response = None
                    sql_query = None
                    query_result = None

                    for attachment in attachments:
                        logger.debug(f"Attachment keys: {attachment.keys()}")
                        # Check for text response
                        if "text" in attachment:
                            text_content = attachment.get("text", {})
                            text_response = text_content.get("content", "")
                            logger.debug(f"Found text response: {text_response[:100] if text_response else ''}")
                        # Check for query
                        elif "query" in attachment:
                            query_content = attachment.get("query", {})
                            sql_query = query_content.get("query", "")
                            logger.debug(f"Found SQL query: {sql_query[:100] if sql_query else ''}")
                            # Note: Query results are in poll_result.get("query_result") not in attachments

                    # If Genie returned a SQL query but no text summary,
                    # provide a fallback so the frontend has something to display.
                    if not text_response and sql_query:
                        text_response = f"Genie executed a query but did not return a text summary.\n\nSQL:\n```\n{sql_query[:500]}\n```"

                    return GenieResponse(
                        conversation_id=conversation_id,
                        message_id=message_id,
                        status="completed",
                        response=text_response,
                        sql=sql_query,
                    )

                elif status in ("FAILED", "CANCELLED"):
                    error_msg = poll_result.get("error", {}).get("message", "Query failed")
                    return GenieResponse(
                        conversation_id=conversation_id,
                        message_id=message_id,
                        status="error",
                        error=error_msg,
                    )

                # Still processing, wait and retry
                await asyncio.sleep(1)

            # Timeout
            return GenieResponse(
                conversation_id=conversation_id,
                message_id=message_id,
                status="timeout",
                error="Query timed out after 5 minutes. Try a more specific query or shorter date range.",
            )

    except httpx.RequestError as e:
        return GenieResponse(
            conversation_id=request.conversation_id or "",
            message_id="",
            status="error",
            error=f"Request failed: {str(e)}",
        )
    except Exception as e:
        return GenieResponse(
            conversation_id=request.conversation_id or "",
            message_id="",
            status="error",
            error=f"Unexpected error: {str(e)}",
        )


@router.post("/analyze-anomaly")
async def analyze_anomaly(request: SpendAnomalyAnalysis) -> GenieResponse:
    """Ask Genie to analyze what caused a spend anomaly on a specific date."""
    config = get_genie_config()

    if not config["space_id"]:
        return GenieResponse(
            conversation_id="",
            message_id="",
            status="error",
            error="Genie Space ID not configured. Set GENIE_SPACE_ID environment variable.",
        )

    # Format the change amount and percentage
    direction = "increase" if request.change_amount > 0 else "decrease"
    abs_change_percent = abs(request.change_percent)

    # Construct a short, focused question for Genie (simpler = faster)
    message = f"What were the top 5 cost drivers by SKU on {request.usage_date}? Spend was ${request.daily_spend:,.0f} ({abs_change_percent:.1f}% {direction} from ${request.prev_day_spend:,.0f} previous day)."

    # Use the existing chat endpoint logic
    chat_request = ChatMessage(message=message, conversation_id=None)
    try:
        return await chat(chat_request)
    except Exception as e:
        logger.error(f"Error analyzing anomaly for {request.usage_date}: {e}")
        return GenieResponse(
            conversation_id="",
            message_id="",
            status="error",
            error=f"Failed to analyze spend anomaly: {str(e)}",
        )


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str) -> dict[str, Any]:
    """Get conversation history."""
    config = get_genie_config()

    if not config["space_id"]:
        raise HTTPException(status_code=400, detail="Genie Space ID not configured")

    headers = {
        "Authorization": f"Bearer {config['token']}",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            url = f"{config['host']}/api/2.0/genie/spaces/{config['space_id']}/conversations/{conversation_id}"
            response = await client.get(url, headers=headers)

            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)

            return response.json()

    except httpx.RequestError as e:
        raise HTTPException(status_code=500, detail=str(e))
