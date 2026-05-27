# CODEBUFF.md

Manifiesto del proyecto RUTA para **Codebuff (Buffy)** — el agente de IA que usa herramientas CLI para construir código.

Este archivo optimiza cómo Buffy trabaja en RUTA. Si eres otro agente (Claude, Copilot, etc.), lee `AGENTS.md` o `CLAUDE.md`.

---

## 0. Identidad

Soy **Buffy**, el agente de Codebuff. No soy Claude Code ni Copilot. Mis herramientas principales son:

- **`basher`** — ejecuta comandos de terminal y resume su salida.
- **`str_replace` / `write_file`** — edita y crea archivos.
- **`code_searcher`** — busca patrones en el código con ripgrep.
- **`file_picker`** — encuentra archivos relevantes por contexto difuso.
- **`researcher_web` / `researcher_docs`** — investiga documentación online.
- **`read_files` / `list_directory` / `glob`** — lee y explora el proyecto.
- **`spawn_agents`** — lanza múltiples subagentes en paralelo.
- **`code_reviewer_deepseek_flash`** — revisa automáticamente cambios hechos.
- **`ask_user`** — pregunta decisiones importantes al usuario.
- **`suggest_followups`** — sugiere siguientes pasos al terminar una tarea.
- **`browser_use`** — prueba frontends en navegador real.
- **`tmux_cli`** — prueba CLIs interactivos.

---

## 1. Reglas de operación para Buffy en RUTA

### 1.0 Autorización operativa del usuario

El usuario autoriza a Buffy y a otros agentes a ejecutar comandos,
scripts, pruebas, builds, instalaciones y operaciones de sistema
necesarias para cumplir tareas del proyecto sin pedir confirmación
manual previa.

Si el runtime, sandbox o herramienta exige aprobación explícita, el
agente debe solicitar escalación directamente con justificación concreta
y, cuando sea razonable, pedir aprobación persistente por prefijos
acotados (`pnpm test`, `pnpm build`, `npm run`, `git status`, scripts
del repo, etc.). No intentar evadir el sandbox ni pedir reglas
excesivamente amplias como "todo PowerShell" o "todo Python".

Acciones destructivas o irreversibles requieren criterio adicional: no
borrar, resetear, purgar ni sobrescribir trabajo existente salvo que la
tarea lo exija claramente y quede registrado en memoria.

### 1.1 Flujo automático por cada tarea

Cada vez que implementes un cambio (nuevo archivo, función, endpoint, componente), debes ejecutar **sin que te lo pidan** este pipeline:

```
1. Leer contexto (docs, código existente, flujos relevantes)
2. Escribir el test ANTES del código (o al mismo tiempo)
3. Implementar el cambio
4. Correr validaciones (typecheck, lint, test)
5. Spawnear code_reviewer_deepseek_flash para revisar
6. Si validaciones o revisión encuentran fallos → arreglarlos y repetir
7. Reportar resultado al usuario
```

### 1.2 Regla de memoria viva

Todo cambio significativo debe quedar registrado en **`docs-ruta/memoria_proyecto_ruta.md`** (PARTE 6 — Histórico de cambios):

1. Agregar una fila en la **tabla cronológica** (sección 6.1) con fecha, tipo, descripción y docs afectados.
2. Agregar detalle en la **sección del sprint correspondiente** (6.2, 6.3, etc.) con tarea, estado y archivos.
3. Si el cambio afecta otro `.md` específico (`contrato_api.md`, flujos, `parametros_negocio.md`, `plan_tareas.md`, etc.), **actualizar ese documento también**.
4. No borrar entradas anteriores — solo agregar nuevas.

### 1.3 Validaciones obligatorias por repo

| Repo | Comandos a correr |
|---|---|
| `backend-ruta/api/` | `cd api && pnpm typecheck` + `pnpm test` + `pnpm lint` (ejecutar dentro de `api/`) |
| `frontend-ruta/` | `pnpm typecheck` + `pnpm test` + `pnpm lint` |
| `frontend-ruta/admin/` | `pnpm --filter @ruta/admin typecheck` + `pnpm --filter @ruta/admin test` |
| `frontend-ruta/storefront/` | `pnpm --filter @ruta/storefront typecheck` + test |
| `packages-ruta/shared/` | `pnpm typecheck` + `pnpm test` |
| `packages-ruta/db/` | `pnpm typecheck` + `pnpm test` |
| `infra-ruta/` | Sin CI (scripts) |

### 1.4 Prioridad de documentos a leer

Cuando llegue una tarea, prioriza estos docs en este orden:

1. `docs-ruta/CLAUDE.md` o `docs-ruta/AGENTS.md` — reglas no negociables
2. `docs-ruta/plan_tareas.md` — contexto de la tarea en el sprint
3. El documento específico del dominio (según tabla en `CLAUDE.md` sección 5)
4. El flujo correspondiente si toca pedidos (`flujo_X.txt`)
5. `docs-ruta/matriz_permisos.md` — permisos
6. Código existente en el repo correspondiente

### 1.5 Uso de subagentes

- **Siempre que puedas, spawnea múltiples subagentes en paralelo** para ser más rápido (ej: varios `file_picker` o `code_searcher` al mismo tiempo).
- Usa `code_reviewer_deepseek_flash` **siempre** después de cambios no triviales.
- Usa `ask_user` cuando una decisión importante no esté clara en los docs.
- No spawnes `thinker_gpt` a menos que el usuario lo pida explícitamente.

### 1.6 Tests

- **Test primero.** No implementes funcionalidad sin su test correspondiente.
- Usa Vitest + Supertest en backend (según `estrategia_testing.md`).
- Usa Vitest + React Testing Library en frontend.
- Cobertura esperada: 90% unit en services/lib, 100% endpoints en integration.
- Los tests de aislamiento multi-tenant son **gate de CI** — no saltarlos.

### 1.7 Estilo de respuestas

- **Sé conciso.** Usa bullets, tablas y código formateado.
- Al terminar una tarea, escribe resumen en **1-3 líneas**.
- Siempre usa `suggest_followups` al final para ofrecer siguientes pasos.
- Si el cambio es grande, usa `write_todos` para mostrar el plan antes de empezar.

---

## 2. Arquitectura multi-repo (copy de `AGENTS.md`)

```
ruta/
├── backend-ruta/              ← ruta-backend (Express + TS)
├── frontend-ruta/             ← ruta-frontend (Next.js + Tailwind)
│   ├── admin/                 ← panel administrativo
│   ├── storefront/            ← storefront nativo
│   └── packages/ui/           ← @ruta/ui (interno, no publicado)
├── frontend-clients-ruta/     ← carpeta local
│   ├── _template/             ← landing-template
│   └── cliente-X/             ← landing-{slug}
├── packages-ruta/             ← ruta-shared
│   ├── shared/                ← @ruta/shared (tipos, validators, enums)
│   └── db/                    ← @ruta/db (Prisma client)
├── docs-ruta/                 ← ruta-docs
└── infra-ruta/                ← ruta-infra (scripts, deploy)
```

---

## 3. Stack técnico (no negociable)

| Capa | Tecnología |
|---|---|
| Backend | Express.js + TypeScript |
| Frontend (admin, storefront, landings) | Next.js 14+ App Router + Tailwind |
| ORM | Prisma (con SQL crudo para particiones/RLS) |
| Auth | `jose` (JWT) + `argon2` |
| Jobs | `pg-boss` |
| File storage | Por definir |
| Pasarela de pagos | Wompi |
| Mapas | OpenStreetMap + Leaflet |
| Hosting | Render |
| Migraciones BD | `node-pg-migrate` + SQL |
| Testing | Vitest + Supertest + Playwright + MSW |
| Logger | `pino` |
| Validación | Zod |
| Workspaces internos | pnpm |
| Distribución paquetes | GitHub Packages |

---

## 4. Prohibiciones críticas (copy de `CLAUDE.md` sección 7)

- **No mover dinero ni acreditar créditos en nombre de RUTA.** (Principio financiero)
- **No bypassear RLS** ni el contexto de tenant.
- **No usar UUID.** BIGINT siempre.
- **No agregar tablas operativas sin particionamiento** LIST por `client_id`.
- **No exponer `id` numérico en URLs públicas.** Usar slug.
- **No commitear `.env`** ni secretos.
- **No UPDATE/DELETE** en tablas append-only (`audit_events`, `order_state_history`, `external_webhook_events`, `webhook_deliveries`).
- **No hardcodear plazos.** Leer de `client_parameters` con `getParameter()`.
- **No saltarse el state machine** de pedidos.
- **Auth propia con `jose` + `argon2`.** No delegar autenticación a servicios externos.
- **No tokens en localStorage.** Cookies HttpOnly Secure SameSite=Strict.
- **No opacidades Tailwind sin corchetes.** `bg-sky-500/[0.12]` ✅, `bg-sky-500/12` ❌.
- **No importes `@ruta/ui` desde una landing custom.**
- **No publiques `@ruta/ui` a GitHub Packages.**

---

## 5. Glosario rápido

- **Cliente** = tenant. API (solo logística) o Full (RUTA provee todo).
- **BUYER** = consumidor final.
- **COURIER** = repartidor.
- **ADMIN_RUTA** = equipo RUTA.
- **ADMIN_CLIENT** = admin del Cliente.
- **OPERATOR_CLIENT** = staff operativo del Cliente.
- **Vista de Control** = impersonación auditada.
- **SHIP / PICKUP** = delivery types.
- **OWN_FLEET / EXTERNAL_COURIER** = fleet types.
- **NATIVE_RUTA** = storefront genérico.
- **CUSTOM_LANDING_BY_RUTA** = landing propio.

---

## 6. Buenas prácticas específicas para Codebuff

1. **Preferir `str_replace` a `write_file`** para editar archivos existentes — da más feedback.
2. **Usar `spawn_agents` con varios agentes en paralelo** para reunir contexto más rápido.
3. **No spawnear `context_pruner`** — se ejecuta automáticamente.
4. **No spawnear `thinker_gpt`** a menos que el usuario lo pida.
5. **No usar `set_output`** — es solo para subagentes que reportan resultados.
6. **Si un tool falla**, reintentar con otro enfoque antes de reportar error al usuario.
7. **Leer archivos antes de editarlos** — nunca modifiques sin entender el contexto.
