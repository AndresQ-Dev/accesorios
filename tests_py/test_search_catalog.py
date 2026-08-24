from __future__ import annotations

import sqlite3
from collections.abc import Callable

from flask.testing import FlaskClient

from tests_py.conftest import ORIGIN


def add_product(
    db: sqlite3.Connection,
    code: str,
    article: str,
    *,
    barcode: str | None = None,
    brand: str | None = None,
    category_id: int | None = None,
    price_ars: int | None = 100,
    revision: int = 1,
) -> int:
    cursor = db.execute(
        """INSERT INTO products
        (code, code_key, barcode, brand, brand_key, article, article_key, category_id, price_ars, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            code, code.lower(), barcode, brand, brand.lower() if brand else None, article,
            article.lower(), category_id, price_ars, revision,
        ),
    )
    db.commit()
    return int(cursor.lastrowid)


def search(client: FlaskClient, query: str) -> dict:
    response = client.get(f"/api/v1/search?q={query}", base_url=ORIGIN)
    assert response.status_code == 200
    return response.get_json()


def test_search_ranking_alias_suffix_labels_and_metadata(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_app: Callable[[], str],
) -> None:
    login_app()
    category_id = db.execute(
        "INSERT INTO categories (name, name_key) VALUES ('Cascos', 'cascos')"
    ).lastrowid
    add_product(db, "15833", "Manual", brand="Exact")
    canonical = add_product(
        db, "BARCODE", "Casco ITF", barcode="4440000015833", brand="Scan", category_id=category_id,
    )
    add_product(db, "ALPHA", "Casco", barcode="888888815833", brand="Álpha")
    add_product(db, "ZULU", "Casco", barcode="999999915833", brand="Zulu")
    add_product(db, "15833-PRO", "Manual", brand="Road", revision=4)
    db.execute("INSERT INTO barcode_aliases (alias, product_id) VALUES (?, ?)", ("04440000015833", canonical))
    db.commit()

    assert [item["code"] for item in search(client, "04440000015833")["results"]] == ["BARCODE"]
    assert search(client, "004440000015833")["results"] == []
    assert [item["code"] for item in search(client, "15833")["results"]] == [
        "15833", "15833-PRO", "ALPHA", "BARCODE", "ZULU",
    ]
    assert search(client, "015833")["results"] == []
    descriptive = search(client, "sca cas")
    assert descriptive["results"][0]["code"] == "BARCODE"
    assert descriptive["catalogVersion"] == 4
    assert descriptive["freshness"] is not None


def test_exact_barcode_suppresses_unrelated_descriptive_matches_and_undefined_labels(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_app: Callable[[], str],
) -> None:
    login_app()
    add_product(db, "CANONICAL", "Item", barcode="scan-123")
    add_product(db, "scan-123", "Other")
    payload = search(client, "scan-123")
    assert payload["results"] == [{
        "id": 1, "code": "CANONICAL", "brand": "Sin definir", "article": "Item",
        "category": "Sin definir", "priceArs": 100,
    }]
    assert "stock" not in payload["results"][0]


def test_search_returns_null_price_for_unpriced_products(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_app: Callable[[], str],
) -> None:
    login_app()
    add_product(db, "NO-PRICE", "Sin precio", price_ars=None)

    payload = search(client, "NO-PRICE")

    assert payload["results"][0]["priceArs"] is None
