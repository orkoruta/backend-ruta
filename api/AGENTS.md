# AGENTS.md

Manifiesto del proyecto RUTA para agentes de IA (Codex, Copilot, Cursor,
agentes propios, etc.). Si eres Claude Code, lee `CLAUDE.md` con el
mismo contenido.

Este es el master que vive en `ruta-docs/`. Cada repo tiene su propio
`AGENTS.md` con secciones específicas; las reglas son las mismas.

---

## 0. Antes de empezar: ¿en qué repo estás?

RUTA es un proyecto **multi-repo**. Identifica tu contexto:

| Si estás en | Estás en repo |
|---|---|
| `ruta/backend-ruta/` | `ruta-backend` (Express) |
| `ruta/frontend-ruta/admin/` | `ruta-frontend` (Next.js admin) |
| `ruta/frontend-ruta/storefront/` | `ruta-frontend` (Next.js storefront) |
| `ruta/frontend-clients-ruta/_template/` | `landing-template` |
| `ruta/frontend-clients-ruta/cliente-X/` | `landing-{slug}` |
| `ruta/packages-ruta/{shared,db}/` | `ruta-shared` |
| `ruta/docs-ruta/` | `ruta-docs` |
| `ruta/infra-ruta/` | `ruta-infra` |

---

## 1. Qué es RUTA

Plataforma SaaS multi-tenant para administrar operaciones comerciales
entre Clientes (negocios) y Compradores.

**Dos tipos de Cliente:**

- **Cliente API** (`client_type = 'API'`): plataforma propia; RUTA
  solo logística.
- **Cliente Full** (`client_type = 'FULL'`): RUTA provee todo.
  - Modalidad `NATIVE_RUTA`: storefront genérico de `ruta-frontend`.
  - Modalidad `CUSTOM_LANDING_BY_RUTA`: landing propio en repo
    `landing-{slug}`.

---

## 2. Stack técnico

| Capa | Tecnología | Repo |
|---|---|---|
| Backend | Express + TS | `ruta-backend` |
| Frontend admin / storefront | Next.js + Tailwind | `ruta-frontend` |
| Landings custom | Next.js + branding propio | `landing-{slug}` |
| ORM | Prisma | `ruta-shared/db/` |
| Auth | `jose` + `argon2` | `ruta-backend` |
| Jobs | `pg-boss` | `ruta-backend` |
| File storage | Supabase Storage | externo |
| Pasarela | Wompi | externo |
| Mapas | OSM + Leaflet | frontends |
| Hosting | Render + Supabase | externo |
| Migraciones | `node-pg-migrate` + SQL | `ruta-docs/bd/` |
| Tests | Vitest + Supertest + Playwright + MSW | en cada repo |
| Logger | `pino` | `ruta-backend` |
| Validación | Zod | `@ruta/shared` |
| Workspaces internos | pnpm | `ruta-frontend`, `ruta-shared` |
| Distribución paquetes | GitHub Packages | publica `ruta-shared` |

---

## 3. Estructura multi-repo

```
ruta/
├── backend-ruta/                 ← ruta-backend
├── frontend-ruta/                ← ruta-frontend
├── frontend-clients-ruta/        ← carpeta local
│   ├── _template/           ← landing-template
│   └── cliente-X/           ← landing-{slug}
├── packages-ruta/                ← ruta-shared
├── docs-ruta/                    ← ruta-docs
└── infra-ruta/                   ← ruta-infra
```

Detalle: `ruta-docs/estructura_proyecto.md`.

---

## 4. Reglas no negociables

### 4.1 Principio financiero

**RUTA NO custodia, NO transfiere, NO acredita dinero.** Pagos a
cuentas del Cliente. Reembolsos los ejecuta el Cliente. RUTA solo
registra estados.

### 4.2 Aislamiento multi-tenant

Toda tabla operativa: `client_id BIGINT NOT NULL`. Toda query con
`SET LOCAL app.current_client_id = '<n>'`. RLS activo.

### 4.3 Identificadores

BIGINT siempre. PK simple o `(id, client_id)`. URLs públicas con
slug.

### 4.4 Append-only

No UPDATE/DELETE: `audit_events`, `order_state_history`,
`external_webhook_events`, `webhook_deliveries`.

### 4.5 Idempotencia

`X-Idempotency-Key` obligatorio en mutaciones. TTL 24h.

### 4.6 Particionamiento

LIST por `client_id`. Auto-creado. Tablas nuevas se suman a
`create_client_partitions()`.

### 4.7 Naming

Código en inglés, UI/docs en español. Services y routes en
`snake_case`, tipos en `PascalCase`, constantes en
`SCREAMING_SNAKE_CASE`. Repos base con prefijo `ruta-`, landings con
prefijo `landing-` (sin `ruta-`).

### 4.8 State machine de pedido

Cambios de estados solo a través del state machine en
`ruta-backend/api/src/services/orders/state_machine.ts`.

### 4.9 Bloqueos por tipo de Cliente

Cliente API no tiene: Flujo 1, 4, 5, 6, 7, ni disputas. Rechazar con
422 `LOGISTICS_ONLY_FEATURE_UNAVAILABLE`.

### 4.10 Vista de Control

ADMIN_RUTA impersona con master password. Acciones auditadas con
`acting_via_control_view = TRUE`.

### 4.11 Design system y landings

`@ruta/ui` solo en `ruta-frontend`. Landings custom (`landing-{slug}`)
NO heredan el design system; tienen branding propio. Solo comparten
`@ruta/shared` (tipos/validators).

---

## 5. Documentos por dominio

Todos viven en `ruta-docs/`:

| Tarea | Documento |
|---|---|
| Funcional | `all_ruta.md` |
| Arquitectura | `arquitectura/estrategia_multi_tenant_ruta.md` |
| Estados de pedido | `flujos/flujo_1.txt` a `flujo_7.txt` |
| Convenciones diagramas | `flujos/reglas_para_diagramar_flujos.txt` |
| Endpoints HTTP | `contrato_api.md` |
| Pantallas | `wireframes_mvp.md` |
| Estilos | `diseno/galeria_estilos_ruta.md` |
| Permisos | `matriz_permisos.md` |
| Parámetros | `parametros_negocio.md` |
| Estructura | `estructura_proyecto.md` |
| Testing | `estrategia_testing.md` |
| Auth detallada | `seguridad/ciclo_vida_token.txt` |
| Modelo de datos | `bd/ruta_postgres.sql` |
| Plan de tareas | `plan_tareas.md` |
| Alcance MVP | `mvp_alcance.md` |

---

## 6. Glosario

- **Cliente** = tenant.
- **Comprador / BUYER** = consumidor final.
- **Repartidor / COURIER** = persona que entrega.
- **ADMIN_RUTA, ADMIN_CLIENT, OPERATOR_CLIENT** = roles staff.
- **SHIP / PICKUP** = tipo de entrega.
- **OWN_FLEET / EXTERNAL_COURIER** = quién despacha.
- **NATIVE_RUTA / CUSTOM_LANDING_BY_RUTA** = modalidad de frontend para
  Cliente Full.
- **Vista de Control** = impersonación auditada.
- **Cliente plataforma** = `client_id = 0`.

---

## 7. Prohibiciones

- No mover dinero ni acreditar créditos.
- No bypassear RLS.
- No usar UUID.
- No agregar tablas operativas sin particionamiento.
- No exponer IDs numéricos (usar slug).
- No commitear secretos.
- No UPDATE/DELETE en append-only.
- No hardcodear plazos (usar `client_parameters` + `getParameter()`).
- No saltarse el state machine.
- No usar Supabase Auth.
- No tokens en localStorage.
- No opacidades Tailwind sin corchetes.
- No importar `@ruta/ui` desde una landing custom.
- No publicar `@ruta/ui` a GitHub Packages.

---

## 8. Flujo de una tarea

1. Identifica el repo (sección 0).
2. Lee la tarea en `ruta-docs/plan_tareas.md`.
3. Lee el flujo si toca pedidos.
4. Verifica permisos en `matriz_permisos.md`.
5. Escribe tests primero (state machine, tenant isolation,
   idempotencia).
6. Implementa lógica en `services/` (handlers delgados).
7. Valida con Zod desde `@ruta/shared`.
8. Audita acciones operativas.
9. UI: usa `@ruta/ui` en admin/storefront; componentes propios en
   landings custom.
10. lint + typecheck + tests OK antes de PR.
11. Si modificas BD: schema.prisma en `ruta-shared/db/` + migración +
    update a `ruta-docs/bd/ruta_postgres.sql` + publish `@ruta/db`.

---

## 9. Errores

- Tipados en `ruta-backend/api/src/lib/errors.ts`.
- Response uniforme: `{ code, message, details? }`.
- Códigos en `@ruta/shared/constants/error_codes.ts`.

Críticos: `AUTHENTICATION_REQUIRED` (401), `FORBIDDEN` (403),
`INVALID_STATE_TRANSITION` (422),
`LOGISTICS_ONLY_FEATURE_UNAVAILABLE` (422), `IDEMPOTENCY_CONFLICT`
(409), `OPTIMISTIC_LOCK_FAILED` (409),
`TENANT_ISOLATION_VIOLATION` (500 — bug).

---

## 10. Comandos por repo

**`ruta-backend/`:** `pnpm dev`, `pnpm test`, `pnpm lint`,
`pnpm typecheck`, `pnpm build`.

**`ruta-frontend/`:** `pnpm dev:admin`, `pnpm dev:storefront`,
`pnpm dev`, `pnpm test`, `pnpm test:e2e`, `pnpm build`.

**`ruta-shared/`:** `pnpm build`, `pnpm publish:shared`,
`pnpm publish:db`.

**`landing-{slug}/`:** `pnpm dev`, `pnpm test`, `pnpm build`.

**Cross-repo (desde `~/projects/ruta/`):**

```bash
bash infra/scripts/setup_workspace.sh
bash infra/scripts/apply_migrations.sh
bash infra/scripts/seed_dev_data.sh
bash infra/scripts/create_landing.sh <slug>
```

---

## 11. Sé conservador

Cuando dudes:

- El proyecto tiene mucha documentación. Léela.
- Si parece un atajo, casi seguro está mal.
- Si tu propuesta viola sección 4 o 7, pregunta antes.
- Si no sabes en qué repo estás, mira `pwd` y la sección 0.

---

## 12. Contexto

- Mercado: Colombia. Moneda: COP.
- UI: español. Código: inglés.
- Equipo pequeño con apoyo de IA.
- Documentación viva en `ruta-docs/`.
