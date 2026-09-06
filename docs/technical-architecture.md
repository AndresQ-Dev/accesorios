# Arquitectura técnica de Accesorios

Accesorios es una aplicación privada para consultar precios y administrar el catálogo. Flask sobre Python 3.13 sirve vistas Jinja y la API JSON `/api/v1`; SQLite conserva catálogo, previews y auditoría, mientras que la autenticación no depende de la base; el escáner corre en el navegador con ZXing WASM. Este documento es la referencia de comportamiento actual, no una propuesta de funcionalidades futuras.

## Vista rápida

| Área | Decisión actual |
|---|---|
| Runtime | Python `>=3.13,<3.14`, Flask, Jinja y WSGI. Node `24.x` construye los assets del scanner. |
| Datos | SQLite con journal rollback `DELETE`, claves foráneas y transacciones de escritura `BEGIN IMMEDIATE`. |
| Autenticación | Tokens firmados y temporizados: sesión de aplicación para `/`; sesión admin adicional para `/admin` y APIs admin. |
| Consulta | `GET /api/v1/search?q=` devuelve coincidencias ordenadas y metadata del catálogo. |
| Administración UI | Búsqueda/editor de producto, filtro de precios pendientes y preview/confirmación XLSX. |
| PWA | Cache-first sólo para una lista cerrada de estáticos; HTML, navegaciones y API van a red. |

## Componentes y responsabilidades

| Ruta | Responsabilidad |
|---|---|
| `app/__init__.py` | Factory de Flask, blueprints, CLI y headers defensivos. |
| `app/routes.py` | Páginas Jinja y contratos `/api/v1`. |
| `app/auth.py` | Hashes, sesiones, validación de origen y CSRF. |
| `app/search.py` | Normalización, ranking y búsquedas pública/admin. |
| `app/catalog.py` | Edición de productos/categorías, revisión optimista y auditoría. |
| `app/imports.py` | Validación, preview y confirmación XLSX. |
| `app/db.py`, `app/backups.py` | SQLite, transacciones, backup online, checksum y retención. |
| `app/static/index.js` | Búsqueda pública, resultados y coordinación del scanner. |
| `app/static/admin.js` | Login admin, búsqueda/editor de producto e importación XLSX. |
| `src/client/scanner.ts` | Fuente TypeScript del scanner; se compila a `app/static/scanner.js`. |
| `app/static/service-worker.js` | Lista cerrada de precache y estrategia PWA. |

## Límites de acceso y seguridad

### Sesiones

| Superficie | Requisito |
|---|---|
| `/` y búsqueda pública | Sesión de aplicación (`app_session`). Sin ella, `/` redirige a `/login`. |
| `/admin` | Primero sesión de aplicación; después sesión admin (`admin_session`). Sin la segunda, se muestra sólo el login admin. |
| Lecturas admin | Sesión admin; la sesión de aplicación es prerrequisito. |
| Mutaciones admin | Sesión admin + `Origin` confiable + header `X-CSRF-Token`. |

Session cookies are timestamped and signed with separate app/admin contexts. They are `HttpOnly`, `Secure` in production, `SameSite=Strict`, and scoped to `/`. The signed payload carries the session kind, a random session identifier, and the CSRF token; it is not stored in SQLite. Validation enforces the configured lifetime and rejects tampering or the wrong session kind. Rotating the corresponding password hash changes the derived signing key and invalidates that kind's active sessions. The signing key is never returned to the client.

`Origin` validation still compares against `TRUSTED_ORIGIN` (or the request origin when it is not configured), and state-changing admin requests still require the exact `X-CSRF-Token`. The app session remains a prerequisite for admin authentication. `noindex` only discourages indexing and does not replace these controls.

### Login throttling

Login failures are throttled in process memory by session kind and a SHA-256 hash of the client address. A lock protects both the fast pre-verification check and the authoritative post-verification recheck, so concurrent password checks cannot exceed the limit. Expired buckets are pruned and the number of client buckets is bounded. A successful password clears only its own kind/client bucket.

PythonAnywhere's free plan runs one web worker for this app, so this removes SQLite from both successful and invalid login paths without requiring a paid database. A worker reload or restart resets throttle history; this is the explicit availability tradeoff for avoiding unreliable network-filesystem writes during login. Signed sessions remain valid across restarts while their password hash and age remain valid.

### Credenciales y estado privado

`APP_PASSWORD_HASH` y `ADMIN_PASSWORD_HASH` corresponden a contraseñas independientes. No se deben versionar contraseñas, hashes reales, `.env`, bases SQLite, archivos WAL, XLSX, previews ni backups. `data/` y `BACKUP_DIRECTORY` son estado local o de producción y deben quedar fuera de `/static/`.

## Rutas y contratos

### Consulta pública

| Ruta | Acceso | Contrato |
|---|---|---|
| `GET /api/v1/search?q=<texto>` | Sesión de aplicación | Busca por código, barcode, artículo, marca o categoría; responde `results`, `catalogVersion` y `freshness`. |

Ejemplo:

```bash
curl --cookie 'app_session=<session-cookie>' \
  'https://example.invalid/api/v1/search?q=4440000015833'
```

Una respuesta contiene elementos como:

```json
{
  "results": [{"id": 42, "code": "A-42", "brand": "Sin definir", "article": "Artículo", "category": "Sin definir", "priceArs": null}],
  "catalogVersion": 7,
  "freshness": "2026-08-28 12:00:00"
}
```

La UI muestra `null` como `Sin precio`. En la búsqueda manual, una respuesta sin resultados muestra exactamente `No hay resultados relevantes.`

### Administración visible en la UI

| Ruta | Acceso | Comportamiento |
|---|---|---|
| `GET /api/v1/admin/products?q=<texto>&needsPriceAttention=true` | Sesión admin | Devuelve como máximo 20 resultados. `q` es opcional sólo si `needsPriceAttention=true`; el filtro selecciona `price_ars IS NULL OR price_ars = 0` y se puede combinar con texto. |
| `GET /api/v1/admin/products/<id>` | Sesión admin | Carga un único registro editable. |
| `PATCH /api/v1/admin/products/<id>` | Sesión admin, Origin y CSRF | La UI edita `code`, `barcode`, `article` y `priceArs`, con `expectedRevision` para evitar sobrescrituras. Precio vacío persiste como `null` y se presenta como `Sin precio`. |
| `POST /api/v1/admin/import/preview` | Sesión admin, Origin y CSRF | Crea la preview XLSX persistente. |
| `POST /api/v1/admin/import/confirm` | Sesión admin, Origin y CSRF | Confirma una preview válida de forma atómica. |

Ejemplos de lectura admin y actualización sin credenciales reales:

```bash
curl --cookie 'admin_session=<admin-cookie>; app_session=<app-cookie>' \
  'https://example.invalid/api/v1/admin/products?needsPriceAttention=true'
```

```json
{
  "expectedRevision": 4,
  "code": "A-42",
  "barcode": "4440000015833",
  "article": "Artículo actualizado",
  "priceArs": null
}
```

El `PATCH` anterior también debe enviar un `Origin` permitido y `X-CSRF-Token`. Si la revisión ya cambió, el servidor rechaza la escritura con conflicto en vez de pisar datos más recientes.

### API admin avanzada (sin UI actual)

Las rutas de categorías y los campos `brand` y `categoryId` del `PATCH /api/v1/admin/products/<id>` existen como capacidades de API administrativa avanzada. La UI admin actual **no** ofrece controles para marca ni categoría, ni una interfaz de categorías; no documentarlos como capacidades de pantalla.

## Flujos operativos

### Búsqueda y scanner

```text
GET / -> requiere app_session -> index.html
consulta manual -> GET /api/v1/search?q=... -> resultados o “No hay resultados relevantes.”
scanner -> decodifica localmente -> GET /api/v1/search?q=<código> -> resultado o cierre con mensaje final
```

El navegador solicita cámara en contexto seguro. Las imágenes no se envían al servidor; sólo se consulta el texto decodificado. ZXing WASM es el lector primario ITF/ITF14; `BarcodeDetector` nativo es recuperación cuando ZXing no puede inicializar.

#### Flujo exacto de cero inicial

El scanner acepta únicamente códigos plausibles de 13 o 14 dígitos. La búsqueda manual y el backend no eliminan ceros.

```text
Código detectado
  ├─ no es 13/14 dígitos -> continúa escaneando
  ├─ es 13 dígitos, o 14 sin cero inicial -> consulta original
  │     ├─ match -> muestra resultado y cierra scanner
│     └─ miss -> cierra scanner: Flork aleatorio + “Código no encontrado.”
  └─ es 14 dígitos y empieza con 0 -> consulta original en silencio
        ├─ match -> muestra resultado y cierra scanner
        └─ miss -> reintenta una vez sin el primer 0
              ├─ match -> muestra resultado y cierra scanner
              └─ miss -> cierra scanner: Flork aleatorio + “Código no encontrado.”
```

El primer fallo de un código de 14 dígitos con cero inicial no muestra el estado de “sin resultados” mientras espera el fallback. El estado visual final usa una imagen decorativa aleatoria y no repetida hasta agotar el manifiesto; la frase permanece accesible una sola vez mediante el estado existente. No se muestra para búsquedas manuales, frames ilegibles, errores de cámara/permisos/red, cancelación ni coincidencias. El diagnóstico del scanner no registra el barcode completo.

### Editor de producto

```text
/admin -> app_session -> admin_session -> panel admin
búsqueda (texto y/o precio pendiente) -> lista <= 20
selección -> GET del registro
edición -> PATCH con expectedRevision + Origin + CSRF
```

El filtro de atención trata igual un precio inexistente (`NULL`) y precio cero; son valores distintos para presentación y negocio. El editor permite dejar el precio en blanco, que persiste como `NULL`, no como `0`.

### Preview y confirmación XLSX

La importación no reemplaza al editor: es otro flujo admin.

```text
XLSX -> validación de archivo y filas -> preview persistente
preview -> reference + contentHash + baseCatalogVersion + expiración
confirm -> valida sesión admin, expiración, hash y versión
        -> crea backup SQLite
        -> BEGIN IMMEDIATE: vuelve a validar versión y aplica cambios
        -> auditoría/import_run; borra preview
```

La preview pertenece a la sesión admin que la creó y sobrevive un reload de la web app hasta vencer. La confirmación compara `contentHash` y `baseCatalogVersion`; si el catálogo cambió, se rechaza. El backup se crea antes de mutar y la transacción hace rollback ante error, por lo que la confirmación es atómica.

Los headers XLSX aprobados son `Código`, `C.Barras`, `Articulo`, `Stock fisico` o `Stock físico`, y `Precio`. Un precio vacío se guarda como `NULL`; no equivale a cero.

## Datos, migraciones y backups

| Recurso | Uso |
|---|---|
| `products` | Catálogo, `price_ars` nullable, revisión optimista y timestamps. |
| `categories` / `barcode_aliases` | Categorías y aliases de barcode. |
| `app_sessions` / `admin_sessions` | Tablas legacy conservadas para compatibilidad de migración; la autenticación actual no las lee ni escribe. |
| `login_attempts` | Tabla legacy conservada para compatibilidad de migración; el throttle actual es por proceso. |
| `import_previews` | Preview persistente con actor, hash, versión base, filas y vencimiento. |
| `import_runs` / `audit_log` | Trazabilidad de confirmaciones y operaciones admin. |
| `catalog_metadata` | Versión global usada para detectar conflictos. |

SQLite uses `foreign_keys=ON`, verified `journal_mode=DELETE`, and `busy_timeout=5000`; the busy timeout is configured before any journal transition. WAL is unsupported on PythonAnywhere's distributed filesystem, so every physical connection requires rollback mode and fails clearly if SQLite does not report `delete`. Existing persistent WAL databases transition through SQLite's own PRAGMA on the first uncontended connection; WAL/SHM files must never be deleted manually. SQLAlchemy checkout pre-ping is disabled to avoid an unnecessary filesystem round trip. Writes still use `BEGIN IMMEDIATE`.

`db-upgrade` applies migrations and `db-validate` verifies the schema and journal mode. `backup-create` and XLSX confirmation use SQLite's online backup, write a SHA-256 checksum, and enforce retention. Never run a second writer, legacy importer, or cron process against the same database.

## PWA y ciclo de cache

`app/static/service-worker.js` usa `CACHE_VERSION='precios-static-v5'`. Durante instalación precachea **sólo** su lista cerrada de assets estáticos, incluidos el picker y las cuatro imágenes no repetidas del estado final del scanner. El fetch handler deja HTML, navegaciones, `/api/`, otros orígenes y recursos fuera de esa lista en red; no hay cache de datos o páginas privadas.

Al agregar o cambiar un asset precacheado:

1. Actualizar la lista cerrada en el service worker.
2. Incrementar `CACHE_VERSION`.
3. Desplegar el service worker junto con los assets.
4. Verificar en navegador que el worker nuevo esté activo.

El registro usa alcance `/`; la respuesta del service worker requiere `Service-Worker-Allowed: /`. En PythonAnywhere, un mapping directo de `/static/` puede saltar Flask y sus headers: debe preservar explícitamente ese header o el worker no podrá controlar el alcance esperado.

## Mapa de pruebas y comandos

| Comando | Cobertura |
|---|---|
| `.venv/bin/ruff check app tests_py` | Lint Python. |
| `.venv/bin/mypy app` | Tipado de `app`. |
| `.venv/bin/pytest` | Auth, rutas, búsqueda, edición, importación, migraciones, backups y WSGI. |
| `.venv/bin/python scripts/smoke_wsgi.py` | Import WSGI sin side effect de servidor. |
| `npm test -- --run` | Scanner y superficie frontend con Vitest. |
| `npm run typecheck` | TypeScript sin emitir archivos. |
| `npm run build:python-static` | Bundle scanner y WASM para Flask. |
| `.venv/bin/flask --app wsgi:application db-upgrade` | Migraciones configuradas. |
| `.venv/bin/flask --app wsgi:application db-validate` | Esquema, precio nullable y alias requeridos. |

## Guardrails operativos

- Producción necesita HTTPS; `COOKIE_SECURE=false` sólo corresponde a loopback local.
- El scanner necesita HTTPS para cámara.
- No asumir CI configurado: ejecutar las verificaciones locales indicadas cuando corresponda.
- El build del scanner genera assets estáticos; al cambiar `src/client/scanner.ts` o ZXing, ejecutar el build y desplegar el resultado.
- Las previews vencen y están ligadas a una sesión admin; generar una nueva si expiran, cambia la sesión o cambia el catálogo.
