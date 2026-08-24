from __future__ import annotations

import json

from flask import Blueprint, Response, current_app, jsonify, redirect, render_template, request, url_for

from app.auth import (
    login,
    read_json_payload,
    require_admin,
    require_admin_session,
    require_app,
    set_session_cookie,
)
from app.catalog import add_category, edit_product, list_categories, patch_category
from app.db import read_connection, write_connection
from app.errors import ApiError
from app.imports import confirm_xlsx, preview_xlsx, read_xlsx_upload
from app.search import normalize_search_text, search_catalog

pages = Blueprint("pages", __name__)
api = Blueprint("api", __name__, url_prefix="/api/v1")

SCAN_DEBUG_MAX_KEYS = 40
SCAN_DEBUG_MAX_STRING = 160


@pages.get("/login")
def login_page():  # type: ignore[no-untyped-def]
    return render_template("login.html")


@pages.get("/robots.txt")
def robots_txt():  # type: ignore[no-untyped-def]
    return Response("User-agent: *\nDisallow: /\n", mimetype="text/plain")


@pages.get("/")
def index_page():  # type: ignore[no-untyped-def]
    try:
        require_app()
    except ApiError:
        return redirect(url_for("pages.login_page", next=request.full_path.rstrip("?")))
    return render_template("index.html")


@pages.get("/admin")
def admin_page():  # type: ignore[no-untyped-def]
    try:
        require_app()
    except ApiError:
        return redirect(url_for("pages.login_page", next=request.path))
    try:
        admin_session = require_admin_session(csrf=False)
    except ApiError:
        return render_template("admin.html", admin_authenticated=False, admin_csrf_token="")
    return render_template(
        "admin.html",
        admin_authenticated=True,
        admin_csrf_token=admin_session["csrfToken"],
    )


@api.post("/login")
def app_login():  # type: ignore[no-untyped-def]
    payload, token, max_age = login("app")
    response = jsonify(payload)
    set_session_cookie(response, "app", token, max_age)
    return response


@api.get("/search")
def search():  # type: ignore[no-untyped-def]
    require_app()
    query = request.args.get("q")
    if query is None or normalize_search_text(query) == "":
        raise ApiError(
            400, "INVALID_QUERY", "The q query parameter must not be empty.", {"q": "Required"}
        )
    with read_connection() as connection:
        return jsonify(search_catalog(connection, query))


def _bounded_scan_debug(value, *, depth: int = 0):  # type: ignore[no-untyped-def]
    if depth > 3:
        raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug payload is too deep.")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value
    if isinstance(value, str):
        if len(value) > SCAN_DEBUG_MAX_STRING:
            raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug strings are too long.")
        return value
    if isinstance(value, list):
        if len(value) > SCAN_DEBUG_MAX_KEYS:
            raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug arrays are too large.")
        return [_bounded_scan_debug(item, depth=depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > SCAN_DEBUG_MAX_KEYS:
            raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug objects are too large.")
        cleaned = {}
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > SCAN_DEBUG_MAX_STRING:
                raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug keys are invalid.")
            cleaned[key] = _bounded_scan_debug(item, depth=depth + 1)
        return cleaned
    raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug values are invalid.")


@api.post("/scan-debug")
def scan_debug():  # type: ignore[no-untyped-def]
    require_app()
    payload = read_json_payload()
    if not isinstance(payload, dict):
        raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug payload must be an object.")
    event = payload.get("event")
    if not isinstance(event, str) or not event or len(event) > 64:
        raise ApiError(400, "INVALID_SCAN_DEBUG", "Scan debug event is invalid.")
    cleaned = _bounded_scan_debug(payload)
    current_app.logger.warning(
        "SCAN_DEBUG client=%s %s",
        request.remote_addr,
        json.dumps(cleaned, sort_keys=True, separators=(",", ":"), ensure_ascii=True),
    )
    return "", 204


@api.post("/admin/login")
def admin_login():  # type: ignore[no-untyped-def]
    require_app()
    payload, token, max_age = login("admin")
    response = jsonify(payload)
    set_session_cookie(response, "admin", token, max_age)
    return response


def _positive_id(raw: str, kind: str) -> int:
    try:
        numeric = float(raw)
    except ValueError:
        numeric = 0.0
    if not numeric.is_integer() or numeric < 1 or numeric > 9_007_199_254_740_991:
        raise ApiError(400, f"INVALID_{kind.upper()}_ID", f"{kind.title()} ID must be a positive integer.")
    return int(numeric)


@api.patch("/admin/products/<product_id>")
def patch_product_route(product_id: str):  # type: ignore[no-untyped-def]
    product = _positive_id(product_id, "product")
    actor = require_admin()
    payload = read_json_payload()
    with write_connection() as connection:
        result = edit_product(connection, product, payload, actor)
    return jsonify(result)


@api.get("/admin/categories")
def list_categories_route():  # type: ignore[no-untyped-def]
    require_admin()
    include_inactive = request.args.get("includeInactive", "") in {"true", "1"}
    with read_connection() as connection:
        result = list_categories(connection, include_inactive)
    return jsonify({"categories": result})


@api.post("/admin/categories")
def add_category_route():  # type: ignore[no-untyped-def]
    actor = require_admin()
    payload = read_json_payload()
    with write_connection() as connection:
        result = add_category(connection, payload, actor)
    return jsonify(result), 201


@api.patch("/admin/categories/<category_id>")
def patch_category_route(category_id: str):  # type: ignore[no-untyped-def]
    category = _positive_id(category_id, "category")
    actor = require_admin()
    payload = read_json_payload()
    with write_connection() as connection:
        result = patch_category(connection, category, payload, actor)
    return jsonify(result)


@api.post("/admin/import/preview")
def import_preview_route():  # type: ignore[no-untyped-def]
    actor = require_admin()
    body = read_xlsx_upload()
    return jsonify(preview_xlsx(body, actor))


@api.post("/admin/import/confirm")
def import_confirm_route():  # type: ignore[no-untyped-def]
    actor = require_admin()
    payload = read_json_payload()
    return jsonify(confirm_xlsx(payload, actor))
