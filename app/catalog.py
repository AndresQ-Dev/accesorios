from __future__ import annotations

import json
from typing import Any

from sqlalchemy import Connection, text

from app.errors import ApiError
from app.search import normalize_search_text

VERIFIED_ALIAS = "04440000015833"
VERIFIED_CANONICAL = "4440000015833"


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
    if set(payload) - {"expectedRevision", "priceArs", "brand", "categoryId"}:
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    expected = payload.get("expectedRevision")
    price = payload.get("priceArs")
    if isinstance(expected, bool) or not isinstance(expected, int):
        raise ApiError(422, "INVALID_EDIT", "Product edit is invalid.")
    if isinstance(price, bool) or not isinstance(price, int) or price < 0:
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
        text("SELECT brand, category_id AS categoryId FROM products WHERE id = :id"),
        {"id": product_id},
    ).mappings().one_or_none()
    if current is None:
        raise ApiError(404, "PRODUCT_NOT_FOUND", "Product does not exist.")
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
            "UPDATE products SET brand = :brand, brand_key = :brand_key, category_id = :category_id, "
            "price_ars = :price, revision = revision + 1, updated_at = CURRENT_TIMESTAMP "
            "WHERE id = :id AND revision = :expected"
        ),
        {
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
    _audit(connection, actor_hash, "product.updated", {"expectedRevision": expected}, product_id)
    row = connection.execute(
        text(
            "SELECT products.id, products.code, products.brand, products.article, "
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
        "brand": result["brand"],
        "article": result["article"],
        "priceArs": result["priceArs"],
        "revision": result["revision"],
        "category": category,
    }
