from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from flask import Flask, g, jsonify
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge


@dataclass(slots=True)
class ApiError(Exception):
    status: int
    code: str
    message: str
    fields: dict[str, str] | None = None


def request_id() -> str:
    value = getattr(g, "request_id", None)
    if value is None:
        value = str(uuid4())
        g.request_id = value
    return value


def error_payload(error: ApiError) -> dict[str, Any]:
    detail: dict[str, Any] = {
        "code": error.code,
        "message": error.message,
        "requestId": request_id(),
    }
    if error.fields:
        detail["fields"] = error.fields
    return {"error": detail}


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def handle_api_error(error: ApiError):  # type: ignore[no-untyped-def]
        return jsonify(error_payload(error)), error.status

    @app.errorhandler(RequestEntityTooLarge)
    def handle_too_large(_error: RequestEntityTooLarge):  # type: ignore[no-untyped-def]
        error = ApiError(413, "XLSX_TOO_LARGE", "XLSX upload exceeds the configured limit.")
        return jsonify(error_payload(error)), error.status

    @app.errorhandler(HTTPException)
    def handle_http(error: HTTPException):  # type: ignore[no-untyped-def]
        mapped = ApiError(error.code or 500, "HTTP_ERROR", error.description or "HTTP request failed.")
        return jsonify(error_payload(mapped)), mapped.status

    @app.errorhandler(Exception)
    def handle_unexpected(error: Exception):  # type: ignore[no-untyped-def]
        app.logger.exception("Unhandled request failure", exc_info=error)
        mapped = ApiError(500, "INTERNAL_ERROR", "An unexpected server error occurred.")
        return jsonify(error_payload(mapped)), mapped.status
