from __future__ import annotations

import re
import unicodedata
from typing import Any

from sqlalchemy import Connection, text

UNDEFINED_LABEL = "Sin definir"
ADMIN_SEARCH_LIMIT = 20


def normalize_search_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().split()).lower()


def _spanish_sort_key(value: str) -> tuple[str, str]:
    normalized = normalize_search_text(value)
    folded = "".join(
        character for character in unicodedata.normalize("NFD", normalized)
        if unicodedata.category(character) != "Mn"
    )
    return folded, normalized


def _resolve_barcode_product_id(connection: Connection, barcode: str) -> int | None:
    canonical = connection.execute(
        text("SELECT id FROM products WHERE barcode = :barcode"), {"barcode": barcode}
    ).scalar_one_or_none()
    if canonical is not None:
        return int(canonical)
    alias = connection.execute(
        text("SELECT product_id FROM barcode_aliases WHERE alias = :barcode"), {"barcode": barcode}
    ).scalar_one_or_none()
    return int(alias) if alias is not None else None


PRODUCT_SELECT = """
SELECT products.id, products.code, products.code_key AS codeKey, products.barcode,
       products.brand, products.article, categories.name AS category,
       products.price_ars AS priceArs, products.revision, products.updated_at AS updatedAt
FROM products LEFT JOIN categories ON categories.id = products.category_id
"""


def _rank(product: dict[str, Any], query: str, barcode_id: int | None) -> float | None:
    if product["id"] == barcode_id:
        return 0
    if product["barcode"] is not None and normalize_search_text(product["barcode"]) == query:
        return 0
    if product["codeKey"] == query:
        return 1
    if product["codeKey"].startswith(query):
        return 2
    if re.fullmatch(r"[0-9]{5}", query) and product["barcode"] and product["barcode"].endswith(query):
        return 2.5
    descriptive = normalize_search_text(" ".join(
        value for value in (product["brand"], product["article"], product["category"]) if value is not None
    ))
    tokens = query.split(" ")
    words = descriptive.split(" ")
    if all(any(word.startswith(token) for word in words) for token in tokens):
        return 3
    if all(token in descriptive for token in tokens):
        return 4
    return None


def _result(product: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": product["id"],
        "code": product["code"],
        "brand": product["brand"] or UNDEFINED_LABEL,
        "article": product["article"],
        "category": product["category"] or UNDEFINED_LABEL,
        "priceArs": product["priceArs"],
    }


def search_catalog(connection: Connection, raw_query: str) -> dict[str, Any]:
    query = normalize_search_text(raw_query)
    barcode_id = _resolve_barcode_product_id(connection, query)
    if barcode_id is not None:
        row = connection.execute(
            text(PRODUCT_SELECT + " WHERE products.id = :id"), {"id": barcode_id}
        ).mappings().one_or_none()
        products = [] if row is None else [dict(row)]
    else:
        ranked: list[tuple[float, dict[str, Any]]] = []
        for row in connection.execute(text(PRODUCT_SELECT)).mappings():
            product = dict(row)
            rank = _rank(product, query, barcode_id)
            if rank is not None:
                ranked.append((rank, product))
        ranked.sort(key=lambda entry: (
            entry[0],
            _spanish_sort_key(entry[1]["brand"] or UNDEFINED_LABEL),
            _spanish_sort_key(entry[1]["article"]),
            _spanish_sort_key(entry[1]["code"]),
        ))
        products = [product for _, product in ranked]
    metadata = _catalog_metadata(connection)
    return {
        "results": [_result(product) for product in products],
        "catalogVersion": metadata["catalogVersion"],
        "freshness": metadata["freshness"],
    }


def _catalog_metadata(connection: Connection) -> dict[str, Any]:
    return dict(connection.execute(
        text(
            "SELECT COALESCE(MAX(revision), 0) AS catalogVersion, "
            "MAX(updated_at) AS freshness FROM products"
        )
    ).mappings().one())


def admin_product(connection: Connection, product_id: int) -> dict[str, Any] | None:
    row = connection.execute(
        text(
            "SELECT id, code, barcode, article, price_ars AS priceArs, revision, "
            "updated_at AS updatedAt FROM products WHERE id = :id"
        ),
        {"id": product_id},
    ).mappings().one_or_none()
    return None if row is None else dict(row)


def search_admin_catalog(
    connection: Connection, raw_query: str | None, needs_price_attention: bool = False,
) -> dict[str, Any]:
    query = normalize_search_text(raw_query or "")
    if not query:
        attention_clause = (
            " WHERE products.price_ars IS NULL OR products.price_ars = 0"
            if needs_price_attention else ""
        )
        products = [dict(row) for row in connection.execute(
            text(PRODUCT_SELECT + attention_clause + " ORDER BY products.code_key LIMIT :limit"),
            {"limit": ADMIN_SEARCH_LIMIT},
        ).mappings()]
        metadata = _catalog_metadata(connection)
        return {
            "results": [
                {
                    "id": product["id"], "code": product["code"], "barcode": product["barcode"],
                    "article": product["article"], "priceArs": product["priceArs"],
                    "revision": product["revision"], "updatedAt": product["updatedAt"],
                }
                for product in products
            ],
            "catalogVersion": metadata["catalogVersion"],
            "freshness": metadata["freshness"],
        }

    catalog = search_catalog(connection, query)
    results = []
    for item in catalog["results"]:
        if needs_price_attention and item["priceArs"] not in (None, 0):
            continue
        product = admin_product(connection, int(item["id"]))
        if product is not None:
            results.append(product)
        if len(results) == ADMIN_SEARCH_LIMIT:
            break
    return {
        "results": results,
        "catalogVersion": catalog["catalogVersion"],
        "freshness": catalog["freshness"],
    }
