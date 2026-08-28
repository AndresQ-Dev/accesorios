from __future__ import annotations

import sqlite3
from collections.abc import Callable

from flask.testing import FlaskClient

from tests_py.conftest import ORIGIN


def admin_headers(csrf: str) -> dict[str, str]:
    return {"Origin": ORIGIN, "X-CSRF-Token": csrf}


def test_category_lifecycle_active_assignment_and_audit(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
) -> None:
    csrf = login_admin()
    created = client.post(
        "/api/v1/admin/categories", json={"name": "  Cascos   Premium "},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert created.status_code == 201
    category = created.get_json()
    assert category["name"] == "Cascos Premium"
    assert category["active"] is True
    duplicate = client.post(
        "/api/v1/admin/categories", json={"name": "cascos premium"},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert duplicate.status_code == 422
    assert duplicate.get_json()["error"]["fields"] == {"name": "Already exists"}
    deactivated = client.patch(
        f"/api/v1/admin/categories/{category['id']}", json={"active": False},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert deactivated.get_json()["deactivatedAt"]
    active = client.get(
        "/api/v1/admin/categories", headers=admin_headers(csrf), base_url=ORIGIN,
    ).get_json()["categories"]
    assert active == []
    all_categories = client.get(
        "/api/v1/admin/categories?includeInactive=true", headers=admin_headers(csrf), base_url=ORIGIN,
    ).get_json()["categories"]
    assert len(all_categories) == 1
    renamed = client.patch(
        f"/api/v1/admin/categories/{category['id']}", json={"name": "Accesorios", "active": True},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert renamed.get_json() == {
        "id": category["id"], "name": "Accesorios", "active": True, "deactivatedAt": None,
    }
    actions = [row[0] for row in db.execute("SELECT action FROM audit_log ORDER BY id")]
    assert actions == ["category.added", "category.deactivated", "category.renamed", "category.reactivated"]


def test_optimistic_product_edit_preserves_atomicity_and_active_category_rule(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
) -> None:
    csrf = login_admin()
    active = db.execute("INSERT INTO categories (name, name_key) VALUES ('Cascos', 'cascos')").lastrowid
    inactive = db.execute(
        "INSERT INTO categories (name, name_key, active) VALUES ('Archivo', 'archivo', 0)"
    ).lastrowid
    product = db.execute(
        """INSERT INTO products (code, code_key, brand, article, article_key, price_ars)
        VALUES ('EDIT-1', 'edit-1', 'Old', 'Casco', 'casco', 100)"""
    ).lastrowid
    db.commit()
    changed = client.patch(
        f"/api/v1/admin/products/{product}",
        json={"expectedRevision": 1, "priceArs": 125, "brand": None, "categoryId": active},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert changed.status_code == 200
    assert changed.get_json()["category"] == {"id": active, "name": "Cascos", "active": True}
    stale = client.patch(
        f"/api/v1/admin/products/{product}", json={"expectedRevision": 1, "priceArs": 999},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert stale.status_code == 409
    rejected = client.patch(
        f"/api/v1/admin/products/{product}",
        json={"expectedRevision": 2, "priceArs": 125, "categoryId": inactive},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert rejected.status_code == 422
    row = db.execute(
        "SELECT price_ars, revision, category_id FROM products WHERE id = ?", (product,)
    ).fetchone()
    assert tuple(row) == (125, 2, active)
    action = db.execute(
        "SELECT action FROM audit_log WHERE product_id = ?", (product,)
    ).fetchone()[0]
    assert action == "product.updated"


def test_admin_product_lookup_requires_admin_and_returns_limited_editable_records(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_app: Callable[[], str],
    login_admin: Callable[[], str],
) -> None:
    product = db.execute(
        """INSERT INTO products (code, code_key, barcode, article, article_key, price_ars)
        VALUES ('HELMET-1', 'helmet-1', '789', 'Casco integral', 'casco integral', 200)"""
    ).lastrowid
    db.executemany(
        """INSERT INTO products (code, code_key, article, article_key, price_ars)
        VALUES (?, ?, ?, ?, ?)""",
        [
            (f"HELMET-{number}", f"helmet-{number}", "Casco adicional", "casco adicional", 100)
            for number in range(2, 22)
        ],
    )
    db.commit()

    assert client.get("/api/v1/admin/products?q=HELMET", base_url=ORIGIN).status_code == 401
    login_app()
    assert client.get("/api/v1/admin/products?q=HELMET", base_url=ORIGIN).status_code == 401

    login_admin()
    lookup = client.get("/api/v1/admin/products?q=789", base_url=ORIGIN)
    assert lookup.status_code == 200
    assert lookup.get_json()["results"] == [{
        "id": product, "code": "HELMET-1", "barcode": "789", "article": "Casco integral",
        "priceArs": 200, "revision": 1, "updatedAt": lookup.get_json()["results"][0]["updatedAt"],
    }]
    assert len(client.get("/api/v1/admin/products?q=Casco", base_url=ORIGIN).get_json()["results"]) == 20
    rejected_mutation = client.patch(
        f"/api/v1/admin/products/{product}",
        json={"expectedRevision": 1, "priceArs": 200},
        headers={"Origin": ORIGIN},
        base_url=ORIGIN,
    )
    assert rejected_mutation.status_code == 403
    missing = client.get("/api/v1/admin/products/999", base_url=ORIGIN)
    assert missing.status_code == 404
    assert missing.get_json()["error"]["code"] == "PRODUCT_NOT_FOUND"


def test_admin_product_price_attention_filter_supports_blank_and_text_queries(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
) -> None:
    db.executemany(
        """INSERT INTO products (code, code_key, article, article_key, price_ars)
        VALUES (?, ?, ?, ?, ?)""",
        [
            ("NULL-PRICE", "null-price", "Casco sin precio", "casco sin precio", None),
            ("ZERO-PRICE", "zero-price", "Casco precio cero", "casco precio cero", 0),
            ("PRICED", "priced", "Casco con precio", "casco con precio", 250),
        ],
    )
    db.commit()

    assert client.get(
        "/api/v1/admin/products?needsPriceAttention=true", base_url=ORIGIN,
    ).status_code == 401
    login_admin()
    filtered = client.get(
        "/api/v1/admin/products?needsPriceAttention=true", base_url=ORIGIN,
    )
    assert filtered.status_code == 200
    assert [(item["code"], item["priceArs"]) for item in filtered.get_json()["results"]] == [
        ("NULL-PRICE", None), ("ZERO-PRICE", 0),
    ]
    combined = client.get(
        "/api/v1/admin/products?q=Casco&needsPriceAttention=true", base_url=ORIGIN,
    )
    assert {(item["code"], item["priceArs"]) for item in combined.get_json()["results"]} == {
        ("NULL-PRICE", None), ("ZERO-PRICE", 0),
    }
    malformed = client.get(
        "/api/v1/admin/products?needsPriceAttention=false", base_url=ORIGIN,
    )
    assert malformed.status_code == 400
    assert malformed.get_json()["error"]["code"] == "INVALID_PRICE_ATTENTION"


def test_individual_product_edit_updates_identifiers_and_preserves_null_price(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
) -> None:
    product = db.execute(
        """INSERT INTO products (code, code_key, barcode, article, article_key, price_ars)
        VALUES ('OLD', 'old', '111', 'Artículo anterior', 'artículo anterior', 100)"""
    ).lastrowid
    db.commit()
    csrf = login_admin()

    changed = client.patch(
        f"/api/v1/admin/products/{product}",
        json={
            "expectedRevision": 1, "code": " NEW ", "barcode": "222", "article": " Nuevo artículo ",
            "priceArs": 125,
        },
        headers=admin_headers(csrf),
        base_url=ORIGIN,
    )

    assert changed.status_code == 200
    assert changed.get_json()["code"] == "NEW"
    assert changed.get_json()["barcode"] == "222"
    assert changed.get_json()["article"] == "Nuevo artículo"
    assert changed.get_json()["priceArs"] == 125
    assert changed.get_json()["revision"] == 2
    cleared = client.patch(
        f"/api/v1/admin/products/{product}",
        json={
            "expectedRevision": 2,
            "code": "NEW",
            "barcode": "222",
            "article": "Nuevo artículo",
            "priceArs": None,
        },
        headers=admin_headers(csrf),
        base_url=ORIGIN,
    )
    assert cleared.status_code == 200
    assert cleared.get_json()["priceArs"] is None
    row = db.execute(
        "SELECT code, code_key, barcode, article, article_key, price_ars, revision "
        "FROM products WHERE id = ?",
        (product,),
    ).fetchone()
    assert tuple(row) == ("NEW", "new", "222", "Nuevo artículo", "nuevo artículo", None, 3)


def test_individual_product_edit_rejects_invalid_or_conflicting_identifiers_without_mutation(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
) -> None:
    product = db.execute(
        """INSERT INTO products (code, code_key, barcode, article, article_key, price_ars)
        VALUES ('EDIT', 'edit', '111', 'Editable', 'editable', 100)"""
    ).lastrowid
    db.execute(
        """INSERT INTO products (code, code_key, barcode, article, article_key, price_ars)
        VALUES ('TAKEN', 'taken', '222', 'Otro', 'otro', 200)"""
    )
    db.commit()
    csrf = login_admin()
    base = {"expectedRevision": 1, "code": "EDIT", "barcode": "111", "article": "Editable", "priceArs": 100}

    duplicate_code = client.patch(
        f"/api/v1/admin/products/{product}", json={**base, "code": "taken"},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert duplicate_code.status_code == 409
    assert duplicate_code.get_json()["error"]["code"] == "CODE_COLLISION"
    duplicate_barcode = client.patch(
        f"/api/v1/admin/products/{product}", json={**base, "barcode": "222"},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert duplicate_barcode.status_code == 409
    assert duplicate_barcode.get_json()["error"]["code"] == "BARCODE_COLLISION"
    invalid = client.patch(
        f"/api/v1/admin/products/{product}", json={**base, "article": " "},
        headers=admin_headers(csrf), base_url=ORIGIN,
    )
    assert invalid.status_code == 422
    assert invalid.get_json()["error"]["code"] == "INVALID_EDIT"
    row = db.execute(
        "SELECT code, barcode, article, price_ars, revision FROM products WHERE id = ?", (product,)
    ).fetchone()
    assert tuple(row) == ("EDIT", "111", "Editable", 100, 1)
