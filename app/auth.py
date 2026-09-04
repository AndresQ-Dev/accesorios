from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from time import perf_counter
from typing import Any, Literal

from flask import Response, current_app, request
from sqlalchemy import Connection, text
from sqlalchemy.exc import OperationalError

from app.db import read_connection, write_connection
from app.errors import ApiError, request_id

MIN_PBKDF2_ITERATIONS = 600_000
PASSWORD_PREFIX = "pbkdf2-sha256"
SessionKind = Literal["app", "admin"]


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_password_hash(password: str, *, iterations: int = MIN_PBKDF2_ITERATIONS) -> str:
    if iterations < MIN_PBKDF2_ITERATIONS:
        raise ValueError(f"iterations must be at least {MIN_PBKDF2_ITERATIONS}")
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, dklen=32)
    return f"{PASSWORD_PREFIX}${iterations}${_b64url_encode(salt)}${_b64url_encode(derived)}"


def verify_password(encoded_hash: str, password: str) -> bool:
    try:
        prefix, iteration_text, salt_text, expected_text = encoded_hash.split("$")
        iterations = int(iteration_text)
        if prefix != PASSWORD_PREFIX or iterations < MIN_PBKDF2_ITERATIONS:
            return False
        salt = _b64url_decode(salt_text)
        expected = _b64url_decode(expected_text)
        if not salt or not expected:
            return False
        derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, dklen=len(expected))
        return hmac.compare_digest(derived, expected)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _timestamp(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _same_origin() -> None:
    origin = request.headers.get("Origin", "").rstrip("/")
    expected = current_app.config["TRUSTED_ORIGIN"] or request.host_url.rstrip("/")
    if not origin or not hmac.compare_digest(origin, expected):
        raise ApiError(403, "INVALID_ORIGIN", "Request origin is not allowed.")


def read_json_payload() -> Any:
    content_type = request.headers.get("Content-Type", "")
    if "application/json" not in content_type:
        raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.")
    declared = request.content_length or 0
    if declared > current_app.config["JSON_BODY_LIMIT"]:
        raise ApiError(413, "REQUEST_TOO_LARGE", "Request body exceeds 4096 bytes.")
    raw = request.get_data(cache=True)
    if len(raw) > current_app.config["JSON_BODY_LIMIT"]:
        raise ApiError(413, "REQUEST_TOO_LARGE", "Request body exceeds 4096 bytes.")
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ApiError(400, "INVALID_JSON", "Request body must be valid JSON.") from None
    return payload


def _client_key() -> str:
    address = request.remote_addr or "unknown"
    return hashlib.sha256(address.encode()).hexdigest()


def _precheck_throttle(connection: Connection, scope: str, key: str) -> None:
    cutoff = _timestamp(_now() - timedelta(seconds=current_app.config["LOGIN_WINDOW_SECONDS"]))
    count = connection.execute(
        text(
            "SELECT COUNT(*) FROM login_attempts "
            "WHERE scope = :scope AND client_key = :key AND attempted_at > :cutoff"
        ),
        {"scope": scope, "key": key, "cutoff": cutoff},
    ).scalar_one()
    if count >= current_app.config["LOGIN_MAX_ATTEMPTS"]:
        raise ApiError(429, "LOGIN_THROTTLED", "Login is temporarily unavailable. Try again later.")


def _check_throttle(connection: Connection, scope: str, key: str) -> None:
    cutoff = _timestamp(_now() - timedelta(seconds=current_app.config["LOGIN_WINDOW_SECONDS"]))
    connection.execute(text("DELETE FROM login_attempts WHERE attempted_at <= :cutoff"), {"cutoff": cutoff})
    count = connection.execute(
        text("SELECT COUNT(*) FROM login_attempts WHERE scope = :scope AND client_key = :key"),
        {"scope": scope, "key": key},
    ).scalar_one()
    if count >= current_app.config["LOGIN_MAX_ATTEMPTS"]:
        raise ApiError(429, "LOGIN_THROTTLED", "Login is temporarily unavailable. Try again later.")


def _record_failed_login(connection: Connection, scope: str, key: str) -> None:
    connection.execute(
        text("INSERT INTO login_attempts (scope, client_key, attempted_at) VALUES (:scope, :key, :at)"),
        {"scope": scope, "key": key, "at": _timestamp(_now())},
    )


def _clear_login_attempts(connection: Connection, scope: str, key: str) -> None:
    connection.execute(
        text("DELETE FROM login_attempts WHERE scope = :scope AND client_key = :key"),
        {"scope": scope, "key": key},
    )


def _is_sqlite_busy(error: OperationalError) -> bool:
    return isinstance(error.orig, sqlite3.OperationalError) and (
        "locked" in str(error.orig).lower() or "busy" in str(error.orig).lower()
    )


def login(kind: SessionKind) -> tuple[dict[str, str], str, int]:
    _same_origin()
    payload = read_json_payload()
    password = payload.get("password") if isinstance(payload, dict) else None
    if not isinstance(password, str):
        raise ApiError(400, "INVALID_LOGIN", "A password is required.", {"password": "Required"})

    started_at = perf_counter()
    precheck_seconds = 0.0
    verification_seconds = 0.0
    write_seconds = 0.0
    result = "failed"
    scope = f"{kind}-login"
    key = _client_key()
    config_name = "APP_PASSWORD_HASH" if kind == "app" else "ADMIN_PASSWORD_HASH"
    session_table = "app_sessions" if kind == "app" else "admin_sessions"
    token = ""
    csrf_token = ""

    try:
        phase_started_at = perf_counter()
        try:
            with read_connection() as connection:
                _precheck_throttle(connection, scope, key)
        finally:
            precheck_seconds = perf_counter() - phase_started_at

        phase_started_at = perf_counter()
        try:
            authenticated = verify_password(current_app.config[config_name], password)
        finally:
            verification_seconds = perf_counter() - phase_started_at

        phase_started_at = perf_counter()
        try:
            with write_connection() as connection:
                _check_throttle(connection, scope, key)
                if not authenticated:
                    _record_failed_login(connection, scope, key)
                else:
                    _clear_login_attempts(connection, scope, key)
                    connection.execute(
                        text(f"DELETE FROM {session_table} WHERE expires_at <= :now"),
                        {"now": _timestamp(_now())},
                    )
                    token = secrets.token_urlsafe(32)
                    csrf_token = secrets.token_urlsafe(32)
                    expires_at = _now() + timedelta(seconds=current_app.config["SESSION_SECONDS"])
                    connection.execute(
                        text(
                            f"INSERT INTO {session_table} (token_hash, csrf_token, expires_at) "
                            "VALUES (:hash, :csrf, :expires)"
                        ),
                        {"hash": token_hash(token), "csrf": csrf_token, "expires": _timestamp(expires_at)},
                    )
        finally:
            write_seconds = perf_counter() - phase_started_at

        if not authenticated:
            result = "invalid-password"
            code = "INVALID_APP_PASSWORD" if kind == "app" else "INVALID_ADMIN_PASSWORD"
            message = "Invalid credentials." if kind == "app" else "Invalid administrator credentials."
            raise ApiError(401, code, message)

        result = "success"
        return {"csrfToken": csrf_token}, token, current_app.config["SESSION_SECONDS"]
    except OperationalError as error:
        if _is_sqlite_busy(error):
            result = "busy"
            raise ApiError(
                503,
                "LOGIN_BUSY",
                "Login is temporarily unavailable. Try again later.",
                headers={"Retry-After": "2"},
            ) from error
        result = "database-error"
        raise
    except ApiError as error:
        if error.code == "LOGIN_THROTTLED":
            result = "throttled"
        raise
    finally:
        current_app.logger.info(
            "LOGIN_TIMING precheck_ms=%.3f verify_ms=%.3f write_ms=%.3f total_ms=%.3f "
            "session_kind=%s result=%s request_id=%s",
            precheck_seconds * 1000,
            verification_seconds * 1000,
            write_seconds * 1000,
            (perf_counter() - started_at) * 1000,
            kind,
            result,
            request_id(),
        )


def set_session_cookie(response: Response, kind: SessionKind, token: str, max_age: int) -> None:
    name = "app_session" if kind == "app" else "admin_session"
    response.set_cookie(
        name,
        token,
        max_age=max_age,
        secure=current_app.config["COOKIE_SECURE"],
        httponly=True,
        samesite="Strict",
        path="/",
    )


def _session(kind: SessionKind) -> dict[str, str]:
    name = "app_session" if kind == "app" else "admin_session"
    token = request.cookies.get(name)
    if not token:
        label = "Application" if kind == "app" else "Administrator"
        raise ApiError(401, "UNAUTHENTICATED", f"{label} authentication is required.")
    table = "app_sessions" if kind == "app" else "admin_sessions"
    with read_connection() as connection:
        row = (
            connection.execute(
                text(
                    f"SELECT token_hash, csrf_token FROM {table} "
                    "WHERE token_hash = :hash AND expires_at > :now"
                ),
                {"hash": token_hash(token), "now": _timestamp(_now())},
            )
            .mappings()
            .one_or_none()
        )
    if row is None:
        label = "Application" if kind == "app" else "Administrator"
        raise ApiError(401, "UNAUTHENTICATED", f"{label} authentication is required.")
    return {"tokenHash": row["token_hash"], "csrfToken": row["csrf_token"]}


def require_app(*, csrf: bool = False) -> str:
    session = _session("app")
    if csrf:
        _validate_request_security(session["csrfToken"])
    return session["tokenHash"]


def require_admin_session(*, csrf: bool = True) -> dict[str, str]:
    require_app(csrf=False)
    session = _session("admin")
    if csrf:
        _validate_request_security(session["csrfToken"])
    return session


def require_admin(*, csrf: bool = True) -> str:
    session = require_admin_session(csrf=csrf)
    return session["tokenHash"]


def _validate_request_security(expected_csrf: str) -> None:
    _same_origin()
    supplied = request.headers.get("X-CSRF-Token", "")
    if not supplied or not hmac.compare_digest(supplied, expected_csrf):
        raise ApiError(403, "INVALID_CSRF", "CSRF token validation failed.")
