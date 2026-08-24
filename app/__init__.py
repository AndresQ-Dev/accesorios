from __future__ import annotations

import mimetypes
from typing import Any
from uuid import uuid4

from flask import Flask, g, request
from werkzeug.middleware.proxy_fix import ProxyFix

from app.cli import register_cli
from app.config import Config
from app.errors import register_error_handlers
from app.routes import api, pages


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    mimetypes.add_type("image/svg+xml", ".svg")
    app = Flask(__name__, instance_relative_config=False)
    app.config.from_mapping(Config.as_dict())
    if test_config:
        app.config.update(test_config)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[method-assign]

    @app.before_request
    def assign_request_id() -> None:
        g.request_id = str(uuid4())

    @app.after_request
    def secure_response(response):  # type: ignore[no-untyped-def]
        response.headers["X-Request-Id"] = g.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "camera=(self)"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'"
        )
        if request.endpoint == "static":
            response.headers["Cache-Control"] = "no-cache"
            if request.path == "/static/service-worker.js":
                response.headers["Service-Worker-Allowed"] = "/"
        return response

    app.register_blueprint(pages)
    app.register_blueprint(api)
    register_error_handlers(app)
    register_cli(app)
    return app
