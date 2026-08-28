from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy import Connection, text

from app.errors import ApiError
from app.search import normalize_search_text

VERIFIED_ALIAS = "04440000015833"
VERIFIED_CANONICAL = "4440000015833"
PRODUCT_TEXT_LIMIT = 512


def display_text(value: str) -> str:
    return " ".join(value.strip().split())


def catalog_version(connection: Connection) -> int:
    value = connection.execute(
        text(
            "SELECT MAX(COALESCE((SELECT catalog_version FROM catalog_metadata WHERE id = 1), 0), "
            "COALESCE((SELECT MAX(revision) FROM products), 0))"
        )
    ).scalar_one()
    return int(value or 0)


def register_barcode_alias(connection: Connection, alias: str, canonical_barcode: str) -> None:
    canonical_id = connection.execute(
        text("SELECT id FROM products WHERE barcode = :barcode"), {"barcode": canonical_barcode}
    ).scalar_one_or_none()
    if canonical_id is None:
        raise ValueError(f"Canonical barcode {canonical_barcode} does not exist.")
    collision = connection.execute(
        text("SELECT id FROM products WHERE barcode = :alias"), {"alias": alias}
    ).scalar_one_or_none()
    if collision is not None:
        raise ValueError(f"Alias {alias} collides with a canonical barcode.")
    existing = connection.execute(
        text("SELECT product_id FROM barcode_aliases WHERE alias = :alias"), {"alias": alias}
    ).scalar_one_or_none()
    if existing is not None:
        if int(existing) == int(canonical_id):
            return
        raise ValueError(f"Alias {alias} is already registered for a different product.")
    connection.execute(
        text("INSERT INTO barcode_aliases (alias, product_id) VALUES (:alias, :product_id)"),
        {"alias": alias, "product_id": canonical_id},
    )


def register_verified_itf_alias(connection: Connection, canonical_barcode: str) -> None:
    if canonical_barcode == VERIFIED_CANONICAL:
        register_barcode_alias(connection, VERIFIED_ALIAS, canonical_barcode)


def _audit(
    connection: Connection,
    actor_hash: str,
    action: str,
    details: dict[str, Any],
    product_id: int | None = None,
) -> None:
    connection.execute(
        text(
            "INSERT INTO audit_log (actor_session_hash, action, product_id, details) "
            "VALUES (:actor, :action, :product_id, :details)"
        ),
        {
            "actor": actor_hash,
            "action": action,
            "product_id": product_id,
            "details": json.dumps(details, ensure_ascii=False, separators=(",", ":")),
        },
    )


def _edit_text(raw: Any, field: str, *, required: bool = True) -> str | None:
    if not isinstance(raw, str):
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.", {field: "Must be text"})
    value = display_text(raw)
    if required and not value:
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.", {field: "Required"})
    if len(value) > PRODUCT_TEXT_LIMIT:
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.", {field: "Too long"})
    return value or None


def _edit_barcode(raw: Any) -> str | None:
    if raw is None:
        return None
    barcode = _edit_text(raw, "barcode", required=False)
    if barcode is not None and re.search(r"e[+-]?\d+$", barcode, re.IGNORECASE):
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.", {"barcode": "Invalid"})
    return barcode


def _assert_edit_identifier_conflicts(
    connection: Connection,
    product_id: int,
    code_key: str,
    barcode: str | None,
    current_barcode: str | None,
) -> None:
    duplicate_code = connection.execute(
        text("SELECT 1 FROM products WHERE code_key = :key AND id != :id"),
        {"key": code_key, "id": product_id},
    ).first()
    if duplicate_code:
        raise ApiError(409, "CODE_COLLISION", "A product with this code already exists.")
    barcode_key = normalize_search_text(barcode) if barcode else None
    current_barcode_key = normalize_search_text(current_barcode) if current_barcode else None
    if barcode_key is None or barcode_key == current_barcode_key:
        return
    canonical = connection.execute(
        text("SELECT barcode FROM products WHERE id != :id AND barcode IS NOT NULL"),
        {"id": product_id},
    ).scalars()
    aliases = connection.execute(text("SELECT alias FROM barcode_aliases")).scalars()
    if any(normalize_search_text(value) == barcode_key for value in (*canonical, *aliases)):
        raise ApiError(409, "BARCODE_COLLISION", "A barcode belongs to another product.")


def _category_view(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "active": row["active"] == 1,
        "deactivatedAt": row["deactivatedAt"],
    }


CATEGORY_SELECT = (
    "SELECT id, name, name_key AS nameKey, active, deactivated_at AS deactivatedAt FROM categories"
)


def list_categories(connection: Connection, include_inactive: bool) -> list[dict[str, Any]]:
    where = "" if include_inactive else " WHERE active = 1"
    rows = connection.execute(text(CATEGORY_SELECT + where + " ORDER BY name_key")).mappings()
    return [_category_view(dict(row)) for row in rows]


def _parse_category_name(raw: Any) -> tuple[str, str]:
    if not isinstance(raw, str):
        raise ApiError(422, "INVALID_CATEGORY", "Category name must be a string.", {"name": "Required"})
    name_key = normalize_search_text(raw)
    if not name_key:
        raise ApiError(422, "INVALID_CATEGORY", "Category name cannot be empty.", {"name": "Required"})
    return display_text(raw), name_key


def add_category(connection: Connection, payload: Any, actor_hash: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError(422, "INVALID_CATEGORY", "Category payload is invalid.")
    name, name_key = _parse_category_name(payload.get("name"))
    duplicate = connection.execute(
        text("SELECT 1 FROM categories WHERE name_key = :key"), {"key": name_key}
    ).first()
    if duplicate:
        raise ApiError(
            422, "DUPLICATE_CATEGORY_NAME", "A category with this name already exists.",
            {"name": "Already exists"},
        )
    result = connection.execute(
        text("INSERT INTO categories (name, name_key) VALUES (:name, :key)"),
        {"name": name, "key": name_key},
    )
    category_id = int(result.lastrowid or 0)
    _audit(connection, actor_hash, "category.added", {"categoryId": category_id, "name": name})
    row = connection.execute(
        text(CATEGORY_SELECT + " WHERE id = :id"), {"id": category_id}
    ).mappings().one()
    return _category_view(dict(row))


def patch_category(
    connection: Connection,
    category_id: int,
    payload: Any,
    actor_hash: str,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError(422, "INVALID_CATEGORY_EDIT", "Category edit is invalid.")
    keys = set(payload)
    if not keys or not keys <= {"name", "active"}:
        raise ApiError(422, "INVALID_CATEGORY_EDIT", "Category edit is invalid.")
    if "name" in payload and not isinstance(payload["name"], str):
        raise ApiError(422, "INVALID_CATEGORY_EDIT", "Category edit is invalid.")
    if "active" in payload and not isinstance(payload["active"], bool):
        raise ApiError(422, "INVALID_CATEGORY_EDIT", "Category edit is invalid.")
    row = connection.execute(
        text(CATEGORY_SELECT + " WHERE id = :id"), {"id": category_id}
    ).mappings().one_or_none()
    if row is None:
        raise ApiError(404, "CATEGORY_NOT_FOUND", "Category does not exist.")
    current = dict(row)
    name, name_key = current["name"], current["nameKey"]
    if "name" in payload:
        name, name_key = _parse_category_name(payload["name"])
        duplicate = connection.execute(
            text("SELECT 1 FROM categories WHERE name_key = :key AND id != :id"),
            {"key": name_key, "id": category_id},
        ).first()
        if duplicate:
            raise ApiError(
                422, "DUPLICATE_CATEGORY_NAME", "A category with this name already exists.",
                {"name": "Already exists"},
            )
    active = current["active"] if "active" not in payload else int(payload["active"])
    if (name, name_key, active) != (current["name"], current["nameKey"], current["active"]):
        connection.execute(
            text(
                "UPDATE categories SET name = :name, name_key = :key, active = :active, "
                "deactivated_at = CASE WHEN :active = 1 THEN NULL "
                "ELSE COALESCE(deactivated_at, CURRENT_TIMESTAMP) END, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = :id"
            ),
            {"name": name, "key": name_key, "active": active, "id": category_id},
        )
        if name != current["name"] or name_key != current["nameKey"]:
            _audit(
                connection, actor_hash, "category.renamed",
                {"categoryId": category_id, "from": current["name"], "to": name},
            )
        if active != current["active"]:
            action = "category.reactivated" if active else "category.deactivated"
            _audit(connection, actor_hash, action, {"categoryId": category_id})
    updated = connection.execute(
        text(CATEGORY_SELECT + " WHERE id = :id"), {"id": category_id}
    ).mappings().one()
    return _category_view(dict(updated))


def edit_product(
    connection: Connection,
    product_id: int,
    payload: Any,
    actor_hash: str,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    if set(payload) - {
        "expectedRevision", "priceArs", "brand", "categoryId", "code", "barcode", "article"
    }:
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    expected = payload.get("expectedRevision")
    price = payload.get("priceArs")
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 1:
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    if (
        "priceArs" not in payload
        or isinstance(price, bool)
        or (price is not None and (not isinstance(price, int) or price < 0))
    ):
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    if (
        "brand" in payload
        and payload["brand"] is not None
        and (not isinstance(payload["brand"], str) or not payload["brand"].strip())
    ):
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    if "categoryId" in payload and payload["categoryId"] is not None:
        category_id_value = payload["categoryId"]
        if isinstance(category_id_value, bool) or not isinstance(category_id_value, int):
            raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    current = connection.execute(
        text(
            "SELECT code, code_key AS codeKey, barcode, article, brand, "
            "category_id AS categoryId FROM products WHERE id = :id"
        ),
        {"id": product_id},
    ).mappings().one_or_none()
    if current is None:
        raise ApiError(404, "PRODUCT_NOT_FOUND", "Product does not exist.")
    code = current["code"] if "code" not in payload else _edit_text(payload["code"], "code")
    article = current["article"] if "article" not in payload else _edit_text(payload["article"], "article")
    barcode = current["barcode"] if "barcode" not in payload else _edit_barcode(payload["barcode"])
    assert code is not None
    assert article is not None
    code_key = normalize_search_text(code)
    _assert_edit_identifier_conflicts(connection, product_id, code_key, barcode, current["barcode"])
    brand = current["brand"] if "brand" not in payload else payload["brand"]
    if isinstance(brand, str):
        brand = brand.strip()
    category_id = current["categoryId"] if "categoryId" not in payload else payload["categoryId"]
    if "categoryId" in payload and category_id is not None:
        active = connection.execute(
            text("SELECT 1 FROM categories WHERE id = :id AND active = 1"), {"id": category_id}
        ).first()
        if not active:
            raise ApiError(
                422, "INVALID_CATEGORY", "Category must exist and be active.",
                {"categoryId": "Must reference an active category"},
            )
    changed = connection.execute(
            text(
                "UPDATE products SET code = :code, code_key = :code_key, barcode = :barcode, "
                "article = :article, article_key = :article_key, brand = :brand, brand_key = :brand_key, "
                "category_id = :category_id, price_ars = :price, revision = revision + 1, "
                "updated_at = CURRENT_TIMESTAMP "
                "WHERE id = :id AND revision = :expected"
            ),
            {
                "code": code,
                "code_key": code_key,
                "barcode": barcode,
                "article": article,
                "article_key": normalize_search_text(article),
                "brand": brand,
            "brand_key": normalize_search_text(brand) if brand else None,
            "category_id": category_id,
            "price": price,
            "id": product_id,
            "expected": expected,
        },
    )
    if changed.rowcount != 1:
        raise ApiError(409, "REVISION_CONFLICT", "Product changed before this edit could be applied.")
    if barcode is not None:
        try:
            register_verified_itf_alias(connection, barcode)
        except ValueError:
            raise ApiError(409, "BARCODE_COLLISION", "A barcode belongs to another product.") from None
    _audit(connection, actor_hash, "product.updated", {"expectedRevision": expected}, product_id)
    row = connection.execute(
        text(
            "SELECT products.id, products.code, products.barcode, products.brand, products.article, "
            "products.price_ars AS priceArs, products.revision, categories.id AS categoryId, "
            "categories.name AS categoryName, categories.active AS categoryActive "
            "FROM products LEFT JOIN categories ON categories.id = products.category_id "
            "WHERE products.id = :id"
        ),
        {"id": product_id},
    ).mappings().one()
    result = dict(row)
    category = None
    if result["categoryId"] is not None:
        category = {
            "id": result["categoryId"],
            "name": result["categoryName"],
            "active": result["categoryActive"] == 1,
        }
    return {
        "id": result["id"],
        "code": result["code"],
        "barcode": result["barcode"],
        "brand": result["brand"],
        "article": result["article"],
        "priceArs": result["priceArs"],
        "revision": result["revision"],
        "category": category,
        "catalogVersion": catalog_version(connection),
    }
