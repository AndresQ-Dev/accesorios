# Arquitectura técnica de Accesorios

Accesorios es una aplicación privada de consulta de precios y administración de catálogo para accesorios. El runtime principal es Flask sobre Python 3.13, con vistas Jinja, API JSON versionada bajo `/api/v1`, SQLite en modo WAL y una experiencia de escaneo de códigos de barras ejecutada completamente en el navegador.

Este documento describe el stack, la organización del repositorio, los flujos de ejecución y las reglas de negocio relevantes para revisar cómo está construido el proyecto.

## 1. Resumen ejecutivo

La aplicación resuelve dos necesidades:

- **Consulta privada de precios**: el usuario ingresa a `/login`, obtiene una sesión de aplicación y consulta productos por código, código de barras, artículo, marca o categoría desde `/`.
- **Administración protegida del catálogo**: un usuario ya autenticado en la aplicación accede a `/admin`, ingresa una contraseña de administrador independiente y puede preparar/confirmar importaciones XLSX.

La arquitectura actual reemplaza el stack anterior de Astro/Cloudflare/Drizzle. El servidor de producción es PythonAnywhere y el único escritor esperado de la base SQLite debe ser la aplicación Flask. El escáner de navegador vive como fuente TypeScript en `src/client/scanner.ts`, se compila con esbuild y genera `app/static/scanner.js` junto con el WASM de ZXing.

## 2. Stack y tecnologías

| Área | Tecnología | Uso en el proyecto | Archivos principales |
|---|---|---|---|
| Backend | Python 3.13 | Runtime soportado por el paquete (`>=3.13,<3.14`). | `pyproject.toml`, `wsgi.py` |
| Backend | Flask 3.1 | Aplicación WSGI, blueprints de páginas/API, CLI operacional y middleware de respuesta. | `app/__init__.py`, `app/routes.py`, `app/cli.py` |
| Backend | Jinja | Render de páginas HTML privadas: login, búsqueda y admin. | `app/templates/*.html` |
| Backend | Werkzeug `ProxyFix` | Respeta headers de proxy para host/protocolo en PythonAnywhere. | `app/__init__.py` |
| Frontend | JavaScript ES modules | Lógica de login, búsqueda pública, admin, PWA y scanner compilado. | `app/static/*.js` |
| Frontend | TypeScript 5.9 | Fuente mantenible del cliente de escaneo. | `src/client/scanner.ts` |
| Frontend | esbuild 0.28 | Bundling del scanner TypeScript hacia estáticos de Flask. | `scripts/build-python-static.mjs` |
| Frontend | zxing-wasm 3.1.3 | Decodificador principal ITF/ITF14 en navegador. | `src/client/scanner.ts`, `app/static/vendor/zxing_reader.wasm` |
| Frontend | PWA manifest + service worker | Instalabilidad básica y cache estático acotado. No cachea HTML ni API. | `app/static/manifest.webmanifest`, `app/static/service-worker.js`, `app/static/pwa.js` |
| Datos | SQLite | Base local de catálogo, sesiones, auditoría, previews e importaciones. | `data/catalog.sqlite` ignorado por Git |
| Datos | SQLAlchemy Core 2.x | Conexiones, transacciones y SQL explícito. No se usa ORM declarativo. | `app/db.py`, módulos de dominio |
| Datos | Alembic 1.14 | Migraciones incrementales y validación de adopción del esquema. | `alembic/versions/*.py`, `alembic.ini` |
| Datos | openpyxl 3.1 | Lectura segura de archivos XLSX para importación. | `app/imports.py` |
| Seguridad | PBKDF2-HMAC-SHA256 | Hash de contraseñas de aplicación y administrador. | `app/auth.py`, `app/cli.py` |
| Seguridad | Cookies HttpOnly/Secure/SameSite=Strict | Sesiones separadas para aplicación y administrador. | `app/auth.py`, `app/config.py` |
| Seguridad | CSRF + origen confiable | Protección de mutaciones y login por `Origin`/`X-CSRF-Token`. | `app/auth.py`, `app/routes.py` |
| Testing | pytest + pytest-cov | Tests backend Flask, importación, búsqueda, auth, migraciones y backups. | `tests_py/` |
| Testing | ruff | Lint Python. | `pyproject.toml` |
| Testing | mypy | Tipado estático Python para `app`. | `pyproject.toml` |
| Testing | Vitest | Tests unitarios de scanner y superficie HTML/JS. | `tests/unit/` |
| Deployment | PythonAnywhere | Hosting WSGI, virtualenv Python 3.13, mapping `/static/` y variables privadas. | `docs/pythonanywhere.md`, `wsgi.py` |

## 3. Mapa del repositorio

| Ruta | Responsabilidad |
|---|---|
| `app/__init__.py` | Factory `create_app()`, registro de blueprints, CLI y headers de seguridad. |
| `app/routes.py` | Rutas HTML y API JSON: login, búsqueda, admin, categorías, edición, importación y debug del scanner. |
| `app/auth.py` | Hashing PBKDF2, sesiones, cookies, validación de origen, CSRF, límites de JSON y throttling de login. |
| `app/db.py` | Engine SQLAlchemy por ruta SQLite, PRAGMAs (`foreign_keys`, `WAL`, `busy_timeout`) y transacciones `BEGIN IMMEDIATE`. |
| `app/search.py` | Normalización, ranking de búsqueda, resolución de alias de código de barras y metadata de frescura. |
| `app/catalog.py` | Operaciones administrativas de productos/categorías, auditoría y alias ITF verificado. |
| `app/imports.py` | Validación XLSX, preview persistente, confirmación atómica, backup previo y conteo de cambios reales. |
| `app/backups.py` | Backup online SQLite, checksum SHA-256 y retención por cantidad/tamaño. |
| `app/errors.py` | Contrato JSON de errores con `code`, `message`, `requestId` y campos opcionales. |
| `app/cli.py` | Comandos Flask: `db-upgrade`, `db-validate`, `backup-create`, `password-hash`. |
| `app/templates/login.html` | Página de autenticación general de la app. |
| `app/templates/index.html` | Pantalla privada de consulta y diálogo de scanner. |
| `app/templates/admin.html` | Pantalla admin; antes de autenticar admin sólo renderiza login admin mínimo. |
| `app/static/index.js` | Búsqueda manual, render de resultados, formateo de precios/fechas y conexión con scanner. |
| `app/static/admin.js` | Login admin, preview XLSX, confirmación de importación y recuperación de errores. |
| `app/static/login.js` | Login general de aplicación. |
| `app/static/service-worker.js` | Cache estático acotado; excluye HTML navegacional y API. |
| `app/static/manifest.webmanifest` | Manifest PWA de Accesorios. |
| `src/client/scanner.ts` | Fuente TypeScript del scanner privado ITF/ITF14. |
| `scripts/build-python-static.mjs` | Compila `src/client/scanner.ts` a `app/static/scanner.js` y copia el WASM de ZXing. |
| `alembic/versions/` | Migraciones de base: adopción del esquema, tablas runtime, precios nullable. |
| `tests_py/` | Tests backend Flask/SQLite/Alembic. |
| `tests/unit/` | Tests frontend con Vitest. |
| `docs/pythonanywhere.md` | Runbook de despliegue en PythonAnywhere. |
| `.gitignore` | Ignora datos locales, secretos, DBs, Excel, backups, caches y artefactos de entorno. |

Rutas como `data/`, `secrets/`, `*.sqlite`, `*.xlsx`, `backups/` y `.env*` son intencionalmente privadas y no deben publicarse.

## 4. Flujos de runtime

### 4.1 Login de aplicación y búsqueda

```text
Usuario -> GET /                     -> sin app_session: redirect a /login
Usuario -> GET /login                -> Jinja renderiza login.html
Browser -> POST /api/v1/login        -> valida Origin + password de app
Servidor -> app_sessions             -> guarda hash del token + CSRF + expiración
Servidor -> Set-Cookie app_session   -> HttpOnly, Secure, SameSite=Strict
Usuario -> GET /                     -> require_app() permite index.html
Browser -> GET /api/v1/search?q=...  -> require_app(), normaliza query, busca catálogo
Servidor -> JSON                     -> results + catalogVersion + freshness
Browser -> DOM                       -> lista todos los resultados y formatea precio/fecha
```

Ejemplo de protección server-side de la página principal:

```python
@pages.get("/")
def index_page():
    try:
        require_app()
    except ApiError:
        return redirect(url_for("pages.login_page", next=request.full_path.rstrip("?")))
    return render_template("index.html")
```

La búsqueda no modifica datos. `search_catalog()` carga productos y aplica ranking en memoria sobre campos normalizados:

```python
def search_catalog(connection: Connection, raw_query: str) -> dict[str, Any]:
    query = normalize_search_text(raw_query)
    barcode_id = _resolve_barcode_product_id(connection, query)
    ...
    return {
        "results": [_result(product) for product in products],
        "catalogVersion": metadata["catalogVersion"],
        "freshness": metadata["freshness"],
    }
```

El frontend muestra precios nulos como `Sin precio`:

```javascript
function formatArs(value) {
  if (value === null) return 'Sin precio';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(value);
}
```

La fecha de frescura confirmada por el código actual se muestra en formato argentino y zona horaria `America/Argentina/Buenos_Aires`:

```javascript
new Intl.DateTimeFormat('es-AR', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
})
```

### 4.2 Flujo del scanner

```text
Usuario -> botón cámara en /                 -> abre <dialog id="scanner">
ScannerClient.start()                        -> exige contexto seguro HTTPS
Browser -> getUserMedia({ facingMode })      -> video local; no se suben imágenes
Scanner -> ZXing WASM ITF/ITF14              -> lector principal
Scanner -> fallback nativo BarcodeDetector   -> sólo si ZXing no puede inicializar
Scanner -> filtro plausible                  -> acepta sólo 13 o 14 dígitos
Scanner -> onDecode(text)                    -> llama lookupScannedBarcode(text)
lookup -> /api/v1/search?q=<barcode>         -> busca catálogo
match -> cierra cámara                       -> muestra resultado
miss -> closes the scanner                   -> preserves the no-results status
```

Regla relevante: el reintento sin cero inicial es **sólo del scanner**, no de la búsqueda manual ni del backend.

```javascript
async function lookupScannedBarcode(text) {
  input.value = text;
  const outcome = await lookup(text, true);
  if (outcome !== 'not-found' || !/^0[0-9]{13}$/.test(text)) return outcome;
  const withoutLeadingZero = text.slice(1);
  reportScannerDebug({
    event: 'scanner-leading-zero-fallback',
    details: { originalLength: text.length, retryLength: withoutLeadingZero.length },
  });
  input.value = withoutLeadingZero;
  return lookup(withoutLeadingZero, true);
}
```

El scanner registra diagnósticos sin guardar el valor completo del código. El detalle expone longitud, si son dígitos, prefijo/sufijo enmascarado y formato inferido:

```typescript
private codeDetails(text: string) {
  return {
    length: text.length,
    digits: /^\d+$/.test(text),
    prefix: text.length > 2 ? `${text.slice(0, 2)}…` : text,
    suffix: text.length > 2 ? `…${text.slice(-2)}` : text,
    format: text.length === 14 ? 'ITF14' : text.length === 13 ? 'ITF13' : 'unknown',
  };
}
```

### 4.3 Login admin e importación protegida

```text
Usuario -> GET /admin                     -> requiere app_session
Servidor -> require_admin_session(false)  -> si no hay admin_session, renderiza login admin mínimo
Browser -> POST /api/v1/admin/login       -> requiere app_session + Origin + password admin
Servidor -> admin_sessions                -> guarda hash de token admin + CSRF admin
Browser -> muestra panel importación       -> mantiene CSRF admin en memoria/meta
Browser -> preview XLSX                   -> POST protegido con X-CSRF-Token
Browser -> confirm XLSX                   -> POST protegido con X-CSRF-Token
```

El admin tiene una barrera separada: `require_admin_session()` exige primero sesión de aplicación y luego sesión de administrador.

```python
def require_admin_session(*, csrf: bool = True) -> dict[str, str]:
    require_app(csrf=False)
    session = _session("admin")
    if csrf:
        _validate_request_security(session["csrfToken"])
    return session
```

Antes de autenticar como admin, `admin.html` no renderiza el formulario de importación. Sólo muestra un enlace de regreso, el login admin y el estado:

```jinja
{% if admin_authenticated %}
<section id="import-panel" class="panel" aria-labelledby="import-title">
  ...
</section>
{% endif %}
```

### 4.4 Preview/confirmación XLSX

```text
Archivo XLSX -> read_xlsx_upload()
             -> valida Content-Type, tamaño declarado y tamaño real
             -> _preflight_archive(): límites ZIP, sin macros, sin cifrado
             -> openpyxl parsea una hoja única
             -> valida headers exactos/aprobados
             -> valida filas, duplicados normalizados, enteros no negativos y sin fórmulas
Preview      -> calcula creates/updates reales
             -> persiste import_previews con hash, versión base, actor y rows_json
             -> NO muta products
Confirm      -> valida reference/hash/version contra preview
             -> rechaza si venció, cambió el catálogo o hay colisión de barcode
             -> crea backup SQLite antes de mutar
             -> BEGIN IMMEDIATE aplica insert/update, alias verificado, import_run, audit y borra preview
```

Headers permitidos:

| Posición | Header esperado |
|---:|---|
| 1 | `Código` |
| 2 | `C.Barras` |
| 3 | `Articulo` |
| 4 | `Stock fisico` o `Stock físico` |
| 5 | `Precio` |

La vista previa se diseñó como operación no mutante: calcula diferencias y persiste el snapshot para confirmar después.

```python
def preview_xlsx(buffer: bytes, actor_hash: str) -> dict[str, Any]:
    rows = _parse_workbook(buffer)
    with write_connection() as connection:
        existing = _existing_products_by_code(connection)
        creates = 0
        updates = 0
        for row in rows:
            product = existing.get(normalize_search_text(row["code"]))
            if product is None:
                creates += 1
            elif _product_has_import_changes(product, row):
                updates += 1
        ...
```

El comportamiento actual confirmado por código y tests cuenta una actualización sólo cuando hay cambios reales en campos importados:

```python
def _product_has_import_changes(product: dict[str, Any], row: dict[str, Any]) -> bool:
    return any((
        product["code"] != row["code"],
        product["barcode"] != row["barcode"],
        product["article"] != row["article"],
        product["stock"] != row["stock"],
        product["priceArs"] != row["priceArs"],
    ))
```

En confirmación, un producto existente sin cambios no incrementa `revision` ni actualiza `updated_at`. Si no hay altas ni actualizaciones, la versión del catálogo no cambia.

```python
new_version = (
    preview["baseCatalogVersion"] + 1 if creates or updates else preview["baseCatalogVersion"]
)
```

Los precios vacíos llegan como `None` desde `_whole(..., required=False)` y se guardan como `NULL` en `products.price_ars`. La migración `0003_nullable_product_prices` asegura que esa columna permita `NULL`.

### 4.5 Base de datos, migraciones y backups

```text
create_app() -> Config.DATABASE_PATH
get_engine() -> SQLite SQLAlchemy engine por ruta
connect     -> PRAGMA foreign_keys=ON, journal_mode=WAL, busy_timeout=5000
lecturas    -> read_connection()
escrituras  -> write_connection() con BEGIN IMMEDIATE + commit/rollback
Alembic     -> db-upgrade aplica versiones
Validación  -> db-validate verifica tablas, columnas, FK, precio nullable y alias ITF
Backup      -> sqlite3.Connection.backup + sidecar .sha256 + retención
```

Fragmento central de conexión:

```python
@event.listens_for(engine, "connect")
def configure_sqlite(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys = ON")
    cursor.execute("PRAGMA journal_mode = WAL")
    cursor.execute("PRAGMA busy_timeout = 5000")
    cursor.close()

@contextmanager
def write_connection() -> Iterator[Connection]:
    with get_engine().connect() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
```

El backup se crea antes de confirmar una importación:

```python
create_backup()
with write_connection() as connection:
    ...
```

`create_backup()` usa la API online de SQLite, escribe un `.sha256`, verifica el checksum y luego aplica retención por cantidad y bytes.

### 4.6 PWA, cache estático y noindex

```text
HTML Jinja       -> incluye manifest y pwa.js
pwa.js           -> registra /static/service-worker.js con scope /
service worker   -> instala lista cerrada de assets estáticos
fetch handler    -> ignora POST, otros orígenes, /api/, navegaciones y HTML
headers Flask    -> X-Robots-Tag noindex/nofollow/noarchive en toda respuesta
robots.txt       -> Disallow: /
templates        -> meta robots noindex/nofollow/noarchive
```

El service worker evita cachear rutas dinámicas o datos sensibles:

```javascript
if (url.pathname.startsWith('/api/')) return;
if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) return;
if (!STATIC_ASSETS.includes(url.pathname)) return;
```

El `noindex` es una defensa de exposición pública, no un mecanismo de autorización. La autorización real está en sesiones, cookies, CSRF y validaciones server-side.

## 5. Modelo de seguridad

### 5.1 Autenticación doble

Hay dos contraseñas independientes:

| Barrera | Endpoint | Cookie | Tabla | Variable de entorno |
|---|---|---|---|---|
| Aplicación | `POST /api/v1/login` | `app_session` | `app_sessions` | `APP_PASSWORD_HASH` |
| Administrador | `POST /api/v1/admin/login` | `admin_session` | `admin_sessions` | `ADMIN_PASSWORD_HASH` |

La sesión admin no reemplaza la sesión general: la exige como prerequisito. Esto evita que `/admin` sea una superficie independiente accesible sin pasar primero por `/login`.

### 5.2 Hashing de contraseñas

El proyecto usa PBKDF2-HMAC-SHA256 con mínimo de 600.000 iteraciones:

```python
MIN_PBKDF2_ITERATIONS = 600_000
PASSWORD_PREFIX = "pbkdf2-sha256"

def create_password_hash(password: str, *, iterations: int = MIN_PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, dklen=32)
    return f"{PASSWORD_PREFIX}${iterations}${_b64url_encode(salt)}${_b64url_encode(derived)}"
```

Los hashes se generan con:

```bash
flask --app wsgi:application password-hash '<contraseña>'
```

No se deben versionar hashes reales ni contraseñas en texto plano.

### 5.3 Cookies y sesiones

Las cookies de sesión se emiten con:

- `HttpOnly`: no accesibles desde JavaScript.
- `Secure`: sólo HTTPS en producción.
- `SameSite=Strict`: reduce riesgo de envío cross-site.
- `path=/`: válidas para la aplicación completa.

En la base no se guarda el token crudo, sino `sha256(token)`. La tabla almacena además CSRF y expiración.

```python
def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
```

### 5.4 CSRF, origen y límites de request

Las mutaciones admin usan `require_admin()` con CSRF activo. La validación combina `Origin` confiable y header `X-CSRF-Token`:

```python
def _same_origin() -> None:
    origin = request.headers.get("Origin", "").rstrip("/")
    expected = current_app.config["TRUSTED_ORIGIN"] or request.host_url.rstrip("/")
    if not origin or not hmac.compare_digest(origin, expected):
        raise ApiError(403, "INVALID_ORIGIN", "Request origin is not allowed.")

def _validate_request_security(expected_csrf: str) -> None:
    _same_origin()
    supplied = request.headers.get("X-CSRF-Token", "")
    if not supplied or not hmac.compare_digest(supplied, expected_csrf):
        raise ApiError(403, "INVALID_CSRF", "CSRF token validation failed.")
```

`read_json_payload()` limita JSON a 4096 bytes, rechaza media types incorrectos y JSON inválido.

### 5.5 Throttling de login

Los intentos fallidos se guardan por scope (`app-login` o `admin-login`) y clave de cliente hasheada. El límite por defecto es 5 intentos en 15 minutos:

```python
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 5
```

En tests se configura `LOGIN_MAX_ATTEMPTS = 3` para verificar bloqueo sin revelar detalles adicionales.

### 5.6 Headers defensivos

Cada respuesta agrega:

- `X-Request-Id`
- `X-Content-Type-Options: nosniff`
- `X-Robots-Tag: noindex, nofollow, noarchive`
- `Referrer-Policy: same-origin`
- `Permissions-Policy: camera=(self)`
- CSP cerrada a `self`, con `media-src 'self' blob:` y `worker-src 'self' blob:` para scanner/PWA.

## 6. Modelo de datos

| Tabla | Propósito | Campos relevantes |
|---|---|---|
| `products` | Catálogo consultable. | `code`, `code_key`, `barcode`, `brand`, `brand_key`, `article`, `article_key`, `category_id`, `stock`, `price_ars`, `revision`, timestamps. |
| `categories` | Categorías activas/inactivas. | `name`, `name_key`, `active`, `deactivated_at`, timestamps. |
| `barcode_aliases` | Alias que resuelven a un producto canónico. | `alias` PK, `product_id`. |
| `app_sessions` | Sesiones generales. | `token_hash`, `csrf_token`, `expires_at`, `created_at`. |
| `admin_sessions` | Sesiones administrativas. | `token_hash`, `csrf_token`, `expires_at`, `created_at`. |
| `login_attempts` | Throttling de intentos fallidos. | `scope`, `client_key`, `attempted_at`. |
| `import_previews` | Snapshots temporales de importación. | `reference`, `actor_session_hash`, `content_hash`, `base_catalog_version`, `expires_at`, `rows_json`. |
| `import_runs` | Historial de confirmaciones. | `actor_session_hash`, `content_hash`, `base_catalog_version`, `catalog_version`, `row_count`, `created_at`. |
| `audit_log` | Auditoría de operaciones admin. | `actor_session_hash`, `action`, `product_id`, `details`, `created_at`. |
| `catalog_metadata` | Versión global del catálogo. | `id = 1`, `catalog_version`. |

Índices importantes:

- `products_code_key_unique` para códigos normalizados únicos.
- `products_barcode_unique` para barcode canónico único.
- Índices de búsqueda sobre `article_key`, `brand_key`, `category_id`.
- Índices de expiración en sesiones/previews.
- Índice de auditoría por producto.

Alias ITF verificado:

```python
VERIFIED_ALIAS = "04440000015833"
VERIFIED_CANONICAL = "4440000015833"

def register_verified_itf_alias(connection: Connection, canonical_barcode: str) -> None:
    if canonical_barcode == VERIFIED_CANONICAL:
        register_barcode_alias(connection, VERIFIED_ALIAS, canonical_barcode)
```

Esto permite que el código leído como `04440000015833` resuelva al producto cuyo barcode canónico es `4440000015833`, siempre que no haya colisiones.

## 7. Detalles de importación XLSX

### 7.1 Contrato del archivo

El upload debe cumplir:

- Content-Type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Tamaño máximo de 2 MiB (`XLSX_UPLOAD_LIMIT`).
- Archivo ZIP válido.
- Máximo 64 entradas ZIP.
- Máximo 8 MiB expandidos.
- Sin `vbaProject.bin` ni macros.
- Sin cifrado.
- Exactamente una hoja.
- Hasta 10.000 filas de datos y 5 columnas.
- Celdas de hasta 512 caracteres.
- Sin fórmulas.
- Sin notación científica en `C.Barras`.
- `Código` y `Articulo` obligatorios.
- `Stock fisico` y `Precio` enteros no negativos cuando están presentes; pueden quedar vacíos.
- Sin duplicados normalizados de código o código de barras dentro del archivo.

### 7.2 Preview no mutante

La vista previa persiste `rows_json` y metadatos en `import_previews`, pero no cambia `products`. Esto permite:

- Reiniciar/reload de la web app sin perder la preview mientras no expire.
- Vincular la preview a la sesión admin exacta (`actor_session_hash`).
- Confirmar sólo el archivo cuyo `contentHash` coincide.
- Detectar conflicto si el catálogo cambió después del preview.

### 7.3 Confirmación atómica

La confirmación realiza validaciones antes y dentro de la transacción:

1. El payload debe contener exactamente `previewReference`, `contentHash`, `baseCatalogVersion`.
2. La preview debe existir, no estar vencida y pertenecer a la sesión admin.
3. El hash y la versión base deben coincidir.
4. La versión actual del catálogo debe seguir igual.
5. Se crea un backup SQLite verificado antes de mutar.
6. En `BEGIN IMMEDIATE`, se vuelve a validar la versión.
7. Se rechazan colisiones de códigos de barras contra productos o aliases.
8. Se insertan altas y sólo se actualizan productos con cambios reales.
9. Se registra alias ITF verificado cuando corresponde.
10. Se actualiza `catalog_metadata`, se inserta `import_runs`, se audita y se elimina la preview.

Si una operación falla dentro de la transacción, `write_connection()` ejecuta rollback y el catálogo queda en el estado previo.

### 7.4 Conteo de cambios reales

Una fila existente cuenta como actualización sólo si cambia alguno de estos campos importados:

- `code`
- `barcode`
- `article`
- `stock`
- `priceArs`

No se cuenta como actualización por el simple hecho de que el código exista en el XLSX. Esto evita inflar métricas, versiones y timestamps.

### 7.5 Precios vacíos como NULL

`Precio` vacío no se transforma en `0`; se transforma en `NULL`. La UI pública traduce ese valor a `Sin precio`. Esta distinción es importante: `0` sería un precio real cero; `NULL` indica ausencia de precio cargado.

## 8. Detalles del scanner

### 8.1 Decodificación y fallback

El scanner usa ZXing WASM como lector principal para ITF/ITF14:

```typescript
reads = await reader.readBarcodes(frame, {
  formats: ['ITF', 'ITF14'],
  maxNumberOfSymbols: 1,
  tryHarder: true,
  tryRotate: fullEffort,
  tryDenoise: fullEffort,
  returnErrors: true,
});
```

`BarcodeDetector` nativo no se usa como primera opción. Sólo se activa como recuperación cuando falla la carga/inicialización del fallback WASM.

### 8.2 Filtro plausible

El código leído debe pasar:

```typescript
const PLAUSIBLE_BARCODE = /^[0-9]{13,14}$/;
```

Valores cortos, alfanuméricos o con longitud distinta a 13/14 se consideran `unreadable` y el scanner continúa.

### 8.3 Recuperación de cámara

El cliente detecta pérdida de track, video detenido o estancado. Puede reiniciar el stream una vez; si vuelve a fallar, reporta `camera-error`. También intenta foco continuo cuando el navegador lo soporta y expone botón de linterna si el track informa capacidad `torch`.

### 8.4 Reintento con cero inicial

La búsqueda manual no elimina ceros. La recuperación se limita a lecturas del scanner con 14 dígitos que comienzan en `0` y que no tuvieron match:

```text
04440000015833 -> intento original
si no encuentra -> 4440000015833
```

Además existe el alias persistente verificado `04440000015833 -> 4440000015833`, que se valida en migraciones y `db-validate`.

### 8.5 Debug seguro

El debug se activa con `?scanDebug=1` o `localStorage.scanDebug=1`. El cliente envía eventos a `/api/v1/scan-debug`; el endpoint requiere sesión de aplicación, limita profundidad/tamaño del payload y registra JSON acotado. Los tests verifican que los diagnósticos no incluyan el barcode completo.

## 9. Configuración y despliegue en PythonAnywhere

### 9.1 Entry point WSGI

`wsgi.py` exporta la aplicación sin arrancar servidor de desarrollo:

```python
from app import create_app

application = create_app()
```

En PythonAnywhere, el archivo WSGI debe insertar el proyecto en `sys.path` e importar `application` desde `wsgi`.

### 9.2 Variables privadas

Configurar en el entorno privado de PythonAnywhere:

| Variable | Propósito |
|---|---|
| `DATABASE_URL` | Ruta absoluta al SQLite privado. |
| `BACKUP_DIRECTORY` | Ruta absoluta para backups privados. |
| `APP_PASSWORD_HASH` | Hash PBKDF2 de la contraseña de aplicación. |
| `ADMIN_PASSWORD_HASH` | Hash PBKDF2 de la contraseña admin, distinta a la anterior. |
| `TRUSTED_ORIGIN` | Origen HTTPS público, por ejemplo `https://<user>.pythonanywhere.com`. |
| `COOKIE_SECURE` | Debe quedar verdadero en producción; sólo se desactiva en loopback local. |
| `SESSION_SECONDS` | Duración de sesiones, por defecto 8 horas. |
| `PREVIEW_SECONDS` | Duración de previews, por defecto 10 minutos. |
| `BACKUP_RETENTION_COUNT` | Backups retenidos, por defecto 5. |
| `BACKUP_RETENTION_BYTES` | Límite de retención, por defecto 128 MiB. |

No versionar `secrets/pythonanywhere.env`, `.env`, bases, backups ni Excel.

### 9.3 Estáticos y WASM

Antes de desplegar o cuando cambie `src/client/scanner.ts`:

```bash
npm ci
npm run build:python-static
```

El build genera:

- `app/static/scanner.js`
- `app/static/vendor/zxing_reader.wasm`

En PythonAnywhere el mapping recomendado es:

| URL | Directorio |
|---|---|
| `/static/` | `/home/<user>/Precios_accesorios/app/static/` |

El WASM debe servirse con MIME compatible (`application/wasm`). No se debe publicar `data/` ni el directorio completo del proyecto como estático.

### 9.4 Operación de base

Después de subir/preparar la base:

```bash
flask --app wsgi:application backup-create
flask --app wsgi:application db-upgrade
flask --app wsgi:application db-validate
```

Con WAL activo no conviene copiar sólo `catalog.sqlite` desde una app viva. Usar backup online de SQLite o detener el writer e incluir el estado WAL correspondiente.

## 10. Comandos de verificación

| Comando | Qué prueba |
|---|---|
| `ruff check app tests_py` | Estilo, imports, errores Python y reglas configuradas. |
| `mypy app` | Tipado estático del paquete Flask. |
| `pytest` | Auth, errores, búsqueda, importación, migraciones, backups, WSGI y contratos backend. |
| `python scripts/smoke_wsgi.py` | Import WSGI sin `app.run()` y configuración mínima. |
| `npm test -- --run` | Scanner, superficies HTML/JS y reglas de UI con Vitest. |
| `npm run typecheck` | Tipado TypeScript sin emitir archivos. |
| `npm run build:python-static` | Bundle del scanner y copia del WASM para Flask/PythonAnywhere. |
| `flask --app wsgi:application db-upgrade` | Aplica migraciones Alembic sobre la base configurada. |
| `flask --app wsgi:application db-validate` | Verifica esquema requerido, FK, `price_ars` nullable y alias ITF. |
| `flask --app wsgi:application backup-create` | Crea backup online, checksum y retención. |

Para esta documentación se verificó la existencia del archivo y la presencia del nombre de la app con:

```bash
test -f docs/technical-architecture.md
grep -n "Accesorios" docs/technical-architecture.md
```

## 11. Gotchas operacionales conocidos

- **No ejecutar dos writers contra SQLite**: Flask debe ser el único escritor. Un importador legacy, cron o servidor anterior puede generar conflictos y pérdida de consistencia.
- **No copiar una base viva ignorando WAL**: con `journal_mode=WAL`, copiar sólo el archivo `.sqlite` puede omitir cambios recientes.
- **No publicar datos como estáticos**: `data/`, backups, Excel y secrets deben quedar fuera de `/static/` y de Git.
- **`noindex` no autentica**: ayuda a evitar indexación, pero no reemplaza login, CSRF ni autorización server-side.
- **Contraseñas separadas**: cambiar una contraseña requiere generar y configurar su hash correspondiente; app y admin son barreras independientes.
- **`COOKIE_SECURE=false` sólo en local HTTP**: en PythonAnywhere debe usarse HTTPS y cookies seguras.
- **El scanner requiere HTTPS**: `getUserMedia` y contexto seguro son obligatorios para cámara en producción.
- **La búsqueda manual no corrige ceros**: el reintento de cero inicial existe sólo para lecturas del scanner.
- **Preview expira y es de sesión exacta**: si vence, cambia el catálogo o cambia la sesión admin, hay que generar otra preview.
- **Una importación sin cambios reales no debe inflar versión**: el conteo se basa en diff por campos importados.
- **Precio vacío no es cero**: se guarda `NULL` y se muestra `Sin precio`.
- **`src/client/scanner.ts` sigue siendo intencional**: aunque el stack Astro/Cloudflare/Drizzle fue removido, esta fuente TypeScript es parte activa del scanner actual.
- **Rebuild requerido al tocar scanner**: si cambia TypeScript o dependencia ZXing, regenerar `app/static/scanner.js` y el WASM.
