"""Standardized error response utilities.

This module provides consistent error handling patterns across all API endpoints.
Use these functions instead of returning raw error dicts or raising HTTPExceptions
with varying formats.

Usage:
    from server.errors import error_response, api_error

    # For returning error data with 200 status (graceful degradation)
    return error_response("Data not available", details={"reason": "timeout"})

    # For raising HTTP errors (4xx/5xx responses)
    raise api_error(404, "Resource not found")
"""

import logging
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def error_response(
    message: str,
    error_code: str | None = None,
    details: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Create a standardized error response dict for graceful degradation.

    Use this when you want to return a 200 response with error information,
    e.g., when a feature is unavailable but the page should still render.

    Args:
        message: Human-readable error message
        error_code: Optional machine-readable error code (e.g., "DATA_UNAVAILABLE")
        details: Optional dict with additional error context
        **kwargs: Additional fields to merge into the response

    Returns:
        Standardized error response dict with format:
        {
            "error": True,
            "message": "...",
            "error_code": "..." (optional),
            "details": {...} (optional),
            ...additional kwargs
        }

    Example:
        return error_response(
            "AWS CUR data not configured",
            error_code="CUR_NOT_CONFIGURED",
            available=False,
            clusters=[],
        )
    """
    response: dict[str, Any] = {
        "error": True,
        "message": message,
    }

    if error_code:
        response["error_code"] = error_code

    if details:
        response["details"] = details

    # Merge any additional kwargs
    response.update(kwargs)

    return response


def api_error(
    status_code: int,
    message: str,
    error_code: str | None = None,
    details: dict[str, Any] | None = None,
    log: bool = True,
) -> HTTPException:
    """Create a standardized HTTPException for API errors.

    Use this when you want to return 4xx/5xx HTTP status codes.

    Args:
        status_code: HTTP status code (4xx or 5xx)
        message: Human-readable error message
        error_code: Optional machine-readable error code
        details: Optional dict with additional error context
        log: Whether to log the error (default True)

    Returns:
        HTTPException with standardized detail format

    Example:
        raise api_error(404, "Use case not found", error_code="USE_CASE_NOT_FOUND")
    """
    detail: dict[str, Any] = {"message": message}

    if error_code:
        detail["error_code"] = error_code

    if details:
        detail["details"] = details

    if log:
        if status_code >= 500:
            logger.error(f"API error {status_code}: {message}")
        else:
            logger.warning(f"API error {status_code}: {message}")

    return HTTPException(status_code=status_code, detail=detail)


def log_and_error(
    exception: Exception,
    message: str,
    error_code: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Log an exception and return an error response.

    Convenience function that combines logging with error response creation.
    Use for try/except blocks where you want to log the full exception
    but return a sanitized error message to the client.

    Args:
        exception: The caught exception
        message: User-facing error message (should NOT include stack traces)
        error_code: Optional machine-readable error code
        **kwargs: Additional fields to merge into the response

    Returns:
        Standardized error response dict

    Example:
        try:
            result = execute_query(SQL)
        except Exception as e:
            return log_and_error(
                e,
                "Failed to fetch billing data",
                error_code="QUERY_FAILED",
                products=[],
            )
    """
    logger.error(f"{message}: {exception}", exc_info=True)
    return error_response(message, error_code=error_code, **kwargs)
