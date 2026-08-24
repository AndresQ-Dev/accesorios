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
