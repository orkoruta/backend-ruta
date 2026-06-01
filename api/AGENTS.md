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

## 0.1 Autorización operativa del usuario

El usuario autoriza a los agentes a ejecutar los comandos, scripts,
pruebas, builds, instalaciones y operaciones de sistema necesarias para
cumplir las tareas del proyecto sin pedir confirmación manual previa.

Si el runtime, sandbox o herramienta exige aprobación explícita, el
agente debe solicitar escalación directamente usando una justificación
concreta y, cuando sea razonable, pedir aprobación persistente por
prefijos acotados (`pnpm test`, `pnpm build`, `npm run`, `git status`,
scripts del repo, etc.). No intentar evadir el sandbox ni pedir reglas
excesivamente amplias como "todo PowerShell" o "todo Python".

Las acciones destructivas o irreversibles siguen requiriendo criterio:
no borrar, resetear, purgar ni sobrescribir trabajo existente salvo que
la tarea lo exija de forma clara y quede registrado en memoria.

---

## 0.2 Memoria y registro de avance (obligatorio)

El agente debe registrar el progreso **proactivamente**, sin esperar
que el desarrollador lo pida explícitamente.

**Qué registrar sin que te lo pidan:**
- **Tarea completada** → marcar `[x]` en el plan de fase/sprint y
  actualizar el archivo de estado en el directorio de memoria del proyecto.
- **Decisión técnica no obvia** → anotarla en el archivo de proyecto
  relevante de memoria.
- **Feedback o corrección del desarrollador** → guardar como feedback
  de memoria en el mismo turno en que se recibe.
- **Sprint o fase cerrada** → actualizar el archivo de estado y el
  índice `MEMORY.md`.
- **Instrucción del tipo "a partir de ahora", "siempre", "nunca"** →
  guardar como feedback de memoria inmediatamente, no solo aplicarla.
- **Cambio de estrategia o plan** → reflejar en el archivo de plan y en
  `MEMORY.md` en el mismo turno.

Esta regla aplica para **cualquier desarrollador o agente** que trabaje
en este repositorio, independientemente del entorno o la herramienta de IA.

---

## 0.3 Fase 3 — Estrategia local-first (vigente hasta deploy final)

Esta restricción aplica al **código de funcionalidades de Fase 3**,
no a cambios de documentación, configuración ni reglas del proyecto
(CLAUDE.md, AGENTS.md, plan files, etc.), que pueden commitearse y
pushearse a GitHub con normalidad.

**PROHIBIDO para código de funcionalidades de Fase 3:**
- Push a GitHub de ramas con implementación de Fase 3.
- Abrir PRs o mergear código de Fase 3.
- Publicar a GitHub Packages bumps de `@orkoruta/shared` generados
  por Fase 3.
- Desplegar en Render código de Fase 3.

Todo el **código de funcionalidades** de Fase 3 vive en ramas locales
y se sube a GitHub en un único deploy al finalizar, cuando todos los
bloques estén completos y la Validación Pre-Deploy Final esté aprobada.
Ver `docs-ruta/plan_fase3.md` para el detalle y el checklist.

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
| Pasarela | Wompi | externo |
| Mapas | OSM + Leaflet | frontends |
| Hosting | Render | externo |
| Esquema BD | Estado-based SQL (`ruta_postgres.sql`) | `ruta-docs/bd/` |
| Tests | Vitest + Supertest + Playwright + MSW | en cada repo |
| Logger | `pino` + `@logtail/pino` (prod) | `ruta-backend` |
| Validación | Zod | `@orkoruta/shared` |
| Workspaces internos | pnpm | `ruta-frontend`, `ruta-shared` |
| Paquetes | GitHub Packages org orkoruta | `@orkoruta/shared@1.3.0`, `@orkoruta/db@1.0.0` |

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

### 4.12 Observabilidad

Nunca usar `console.log`. Usar siempre el logger pino:
`import { logger } from '../lib/logger.js'` (en backend).
En producción los logs van a Better Stack vía `LOGTAIL_TOKEN`.
Cada request HTTP incluye automáticamente `trace_id`, `requestId`,
`client_id`, `user_id`, `user_type`.

### 4.13 Webhooks salientes

La cola de webhooks corre sobre pg-boss con reintentos automáticos
(1m, 5m, 15m, 60m, 4h). Tablas: `webhook_subscriptions` (no
particionada) y `webhook_deliveries` (particionada, append-only).
No hardcodear URLs de webhook; se configuran por cliente en la BD.

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
- Auth propia con `jose` + `argon2`. No delegar autenticación a servicios externos.
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
7. Valida con Zod desde `@orkoruta/shared`. Para queries a BD usa
   `withTenant(clientId, role, fn)` del helper de `@orkoruta/db`.
8. Audita acciones operativas.
9. UI: usa `@ruta/ui` en admin/storefront; componentes propios en
   landings custom.
10. lint + typecheck + tests OK antes de PR.
11. Si modificas BD: schema.prisma en `packages-ruta/db/` + actualiza
    `ruta-docs/bd/ruta_postgres.sql` + publica `@orkoruta/db` con PAT
    local (no CI): `NPM_TOKEN=<PAT> pnpm --filter @orkoruta/db publish`.
12. Añade logging con `logger.info({...})` o `logger.error({...})` en
    branches críticos del service. Nunca console.log.

---

## 9. Errores

- Tipados en `ruta-backend/api/src/lib/errors.ts`.
- Response uniforme: `{ code, message, details? }`.
- Códigos en `@orkoruta/shared/constants/error_codes.ts`.

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

**`packages-ruta/`:** `pnpm build`.

```bash
# Publicar manualmente con PAT (el CI no tiene permisos suficientes):
NPM_TOKEN=<PAT> pnpm --filter @orkoruta/shared publish
NPM_TOKEN=<PAT> pnpm --filter @orkoruta/db publish
```

**`landing-{slug}/`:** `pnpm dev`, `pnpm test`, `pnpm build`.

**Cross-repo (desde `~/projects/ruta/`):**

```bash
bash infra/scripts/setup_workspace.sh
bash infra/scripts/seed_dev_data.sh
bash infra/scripts/create_landing.sh <slug>
bash infra-ruta/scripts/migrate_prod.sh     # Aplicar SQL en BD de prod (primera vez)
bash infra-ruta/scripts/backup_db.sh        # Backup manual de la BD
bash infra-ruta/scripts/verify_prod.sh      # Verificar estado BD de prod
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

---

## 13. Estado actual del proyecto (2026-05-30)

**Sprints 0–6 completos en código.** El MVP está implementado.

### Qué existe y funciona

- **Auth**: JWT jose+argon2, refresh tokens, cookies HttpOnly, 5 roles.
- **Catálogo**: productos, categorías, importación Excel.
- **Pedidos**: state machine completo (20+ estados), validación, aceptación.
- **Flujo SHIP**: asignación courier (mapa Leaflet+OSM), entrega, cobro COD,
  cancelación post-despacho, return-to-origin, auto-confirmación.
- **Flujo PICKUP**: puntos físicos, verify identity, cobro, entrega.
- **Pagos**: Wompi (online), contra entrega (COD), webhook HMAC.
- **Vista de Control**: ADMIN_RUTA impersona ADMIN_CLIENT (auditado).
- **Dashboards**: métricas ADMIN_CLIENT y ADMIN_RUTA.
- **Configuración**: 4 tabs (info, Wompi, webhooks salientes, parámetros).
- **Auditoría**: log completo por cliente.
- **Observabilidad**: pino JSON + @logtail/pino, trace_id por request.
- **Webhooks salientes**: pg-boss, reintentos automáticos.
- **Tests**: 3947 tests backend (Vitest+Supertest), 14 E2E (Playwright).
- **Backups**: scripts backup/restore en infra-ruta.

### Packages publicados
- `@orkoruta/shared@1.3.0` — tipos, enums, validators Zod.
- `@orkoruta/db@1.0.0` — cliente Prisma + `withTenant()`.

### Pendiente (acción humana)
- Deploy a producción: checklist en `infra-ruta/docs/deploy_produccion.md`.
- Onboarding del cliente piloto.
