import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { HttpError } from '../lib/http_error.js';
import { toApiError } from '../lib/errors.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const parameterListQuerySchema = z.object({
  group: z.string().optional(),
});

const parameterKeyParamsSchema = z.object({
  key: z.string().min(1),
});

const patchParameterBodySchema = z.object({
  value: z.string().min(1, 'El valor no puede estar vacío'),
});

// ── Serializer ────────────────────────────────────────────────────────────────

function serializeParameter(p: {
  id: bigint;
  client_id: bigint;
  parameter_key: string;
  parameter_value: string;
  value_type: string;
  description: string | null;
  is_overrideable_by_client: boolean;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: Number(p.id),
    client_id: Number(p.client_id),
    parameter_key: p.parameter_key,
    parameter_value: p.parameter_value,
    value_type: p.value_type,
    description: p.description,
    is_overrideable_by_client: p.is_overrideable_by_client,
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

export const adminParametersService = {
  /**
   * Los defaults viven en `client_id = 0` y el Cliente solo tiene filas para lo
   * que haya personalizado. Si se listaran únicamente las suyas, la pantalla
   * saldría vacía hasta el primer cambio, así que aquí se combinan: el valor
   * propio gana sobre el global y cada fila indica de dónde viene.
   */
  async list(clientId: number, group?: string) {
    const where = group ? { parameter_key: { startsWith: `${group}.` } } : {};

    const ownParameters = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.client_parameters.findMany({
        where: { client_id: BigInt(clientId), ...where },
        orderBy: { parameter_key: 'asc' },
      }),
    );

    // El Cliente plataforma ya está viendo los globales: no hay nada que heredar.
    if (clientId === 0) {
      return ownParameters.map((p) => ({ ...serializeParameter(p), source: 'CLIENT' as const }));
    }

    const globalParameters = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.client_parameters.findMany({
        where: { client_id: BigInt(0), ...where },
        orderBy: { parameter_key: 'asc' },
      }),
    );

    const ownByKey = new Map(ownParameters.map((p) => [p.parameter_key, p]));

    const inherited = globalParameters
      .filter((g) => !ownByKey.has(g.parameter_key))
      .map((g) => ({ ...serializeParameter(g), client_id: clientId, source: 'GLOBAL' as const }));

    const own = ownParameters.map((p) => ({ ...serializeParameter(p), source: 'CLIENT' as const }));

    return [...own, ...inherited].sort((a, b) => a.parameter_key.localeCompare(b.parameter_key));
  },

  async upsert(clientId: number, key: string, value: string) {
    const existing = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.client_parameters.findUnique({
        where: { client_id_parameter_key: { client_id: BigInt(clientId), parameter_key: key } },
      }),
    );

    // Verify the parameter is overrideable when it already exists globally (client_id=0)
    if (existing && !existing.is_overrideable_by_client) {
      throw new HttpError(403, 'FORBIDDEN', 'Este parámetro no puede ser modificado por el Cliente');
    }

    const now = new Date();

    if (existing) {
      // UPDATE existing parameter for this client
      const updated = await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.client_parameters.update({
          where: { client_id_parameter_key: { client_id: BigInt(clientId), parameter_key: key } },
          data: { parameter_value: value, updated_at: now },
        }),
      );
      return serializeParameter(updated);
    }

    // Check if there is a global default for this key to inherit value_type
    const globalParam = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      tx.client_parameters.findUnique({
        where: { client_id_parameter_key: { client_id: BigInt(0), parameter_key: key } },
      }),
    );

    if (globalParam && !globalParam.is_overrideable_by_client) {
      throw new HttpError(403, 'FORBIDDEN', 'Este parámetro no puede ser modificado por el Cliente');
    }

    // INSERT new parameter for this client, inheriting value_type from global or defaulting to STRING
    const valueType = globalParam?.value_type ?? 'STRING';
    const description = globalParam?.description ?? null;

    const created = await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.client_parameters.create({
        data: {
          client_id: BigInt(clientId),
          parameter_key: key,
          parameter_value: value,
          value_type: valueType,
          description,
          is_overrideable_by_client: true,
          created_at: now,
          updated_at: now,
        },
      }),
    );
    return serializeParameter(created);
  },

  async auditParameterUpdated(
    clientId: number,
    actorUserId: number,
    actorRole: string,
    key: string,
    newValue: string,
  ) {
    await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.audit_events.create({
        data: {
          client_id: BigInt(clientId),
          actor_user_id: BigInt(actorUserId),
          actor_type: 'USER',
          actor_role: actorRole,
          action: 'PARAMETER_UPDATED',
          entity_type: 'client_parameters',
          entity_id: null,
          metadata: { parameter_key: key, new_value: newValue },
          result: 'SUCCESS',
        },
      }),
    );
  },
};

// ── Router factory ────────────────────────────────────────────────────────────

type AdminParametersService = typeof adminParametersService;

export function createAdminParametersRouter(service: AdminParametersService = adminParametersService): Router {
  const router = Router();

  // GET /admin/parameters — list parameters for current tenant
  router.get('/', requireAdminClient, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { group } = parameterListQuerySchema.parse(req.query);
      const data = await service.list(req.user!.client_id, group);
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  // PATCH /admin/parameters/:key — update or create a parameter for current tenant
  router.patch(
    '/:key',
    requireIdempotencyKey,
    requireAdminClient,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { key } = parameterKeyParamsSchema.parse(req.params);
        const { value } = patchParameterBodySchema.parse(req.body);
        const result = await service.upsert(req.user!.client_id, key, value);

        // Fire-and-forget audit (non-blocking; failures should not break the response)
        service
          .auditParameterUpdated(
            req.user!.client_id,
            req.user!.id,
            req.user!.user_type,
            key,
            value,
          )
          .catch(() => {
            // audit failure is non-fatal
          });

        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // Catch explicit HttpError from auth guard when no match
  router.use((_req: Request, res: Response) => {
    res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Endpoint no encontrado'));
  });

  return router;
}
