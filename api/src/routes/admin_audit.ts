import { z } from 'zod';
import { dateFilterSchema, startOfBogotaDay, endOfBogotaDayExclusive } from '@orkoruta/shared';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { withTenantReadOnly } from '@orkoruta/db';
import { requireAdminClient, requireAdminRuta } from '../middleware/auth.js';
import { toApiError } from '../lib/errors.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const auditListQuerySchema = z.object({
  entity_type: z.string().optional(),
  user_id: z.coerce.number().int().positive().optional(),
  from: dateFilterSchema.optional(),
  to: dateFilterSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

const rutaAdminAuditQuerySchema = auditListQuerySchema.extend({
  client_id: z.coerce.number().int().positive().optional(),
});

// ── Serializer ────────────────────────────────────────────────────────────────

function serializeAuditEvent(e: {
  id: bigint;
  client_id: bigint;
  actor_user_id: bigint | null;
  actor_api_key_id: bigint | null;
  actor_type: string | null;
  actor_role: string | null;
  acting_via_control_view: boolean;
  impersonator_user_id: bigint | null;
  control_view_session_id: bigint | null;
  action: string;
  entity_type: string;
  entity_id: bigint | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: unknown;
  result: string;
  occurred_at: Date;
}) {
  return {
    id: Number(e.id),
    client_id: Number(e.client_id),
    actor_user_id: e.actor_user_id ? Number(e.actor_user_id) : null,
    actor_api_key_id: e.actor_api_key_id ? Number(e.actor_api_key_id) : null,
    actor_type: e.actor_type,
    actor_role: e.actor_role,
    acting_via_control_view: e.acting_via_control_view,
    impersonator_user_id: e.impersonator_user_id ? Number(e.impersonator_user_id) : null,
    control_view_session_id: e.control_view_session_id ? Number(e.control_view_session_id) : null,
    action: e.action,
    entity_type: e.entity_type,
    entity_id: e.entity_id ? Number(e.entity_id) : null,
    ip_address: e.ip_address,
    user_agent: e.user_agent,
    metadata: e.metadata,
    result: e.result,
    occurred_at: e.occurred_at.toISOString(),
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

export const adminAuditService = {
  async listForTenant(clientId: number, query: z.infer<typeof auditListQuerySchema>) {
    const skip = (query.page - 1) * query.page_size;
    const where = {
      client_id: BigInt(clientId),
      ...(query.entity_type ? { entity_type: query.entity_type } : {}),
      ...(query.user_id ? { actor_user_id: BigInt(query.user_id) } : {}),
      ...(query.from || query.to
        ? {
            occurred_at: {
              ...(query.from ? { gte: startOfBogotaDay(query.from) } : {}),
              ...(query.to ? { lt: endOfBogotaDayExclusive(query.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.audit_events.findMany({
          where,
          orderBy: { occurred_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.audit_events.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeAuditEvent),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  async listGlobal(query: z.infer<typeof rutaAdminAuditQuerySchema>) {
    const skip = (query.page - 1) * query.page_size;

    // Build base where without client_id constraint (cross-tenant)
    const where = {
      ...(query.client_id ? { client_id: BigInt(query.client_id) } : {}),
      ...(query.entity_type ? { entity_type: query.entity_type } : {}),
      ...(query.user_id ? { actor_user_id: BigInt(query.user_id) } : {}),
      ...(query.from || query.to
        ? {
            occurred_at: {
              ...(query.from ? { gte: startOfBogotaDay(query.from) } : {}),
              ...(query.to ? { lt: endOfBogotaDayExclusive(query.to) } : {}),
            },
          }
        : {}),
    };

    // Use client_id=0 as the sentinel for ADMIN_RUTA cross-tenant reads
    const [items, total] = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
      Promise.all([
        tx.audit_events.findMany({
          where,
          orderBy: { occurred_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.audit_events.count({ where }),
      ]),
    );

    return {
      data: items.map(serializeAuditEvent),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },
};

// ── Router factories ──────────────────────────────────────────────────────────

type AdminAuditService = typeof adminAuditService;

/**
 * Router for ADMIN_CLIENT audit — only sees events for their own tenant.
 * Mount at: /admin/audit-events
 */
export function createAdminAuditRouter(service: AdminAuditService = adminAuditService): Router {
  const router = Router();

  // GET /admin/audit-events
  router.get('/', requireAdminClient, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = auditListQuerySchema.parse(req.query);
      res.json(await service.listForTenant(req.user!.client_id, query));
    } catch (error) {
      next(error);
    }
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Endpoint no encontrado'));
  });

  return router;
}

/**
 * Router for ADMIN_RUTA audit — cross-tenant visibility.
 * Mount at: /ruta-admin/audit-events
 */
export function createRutaAdminAuditRouter(service: AdminAuditService = adminAuditService): Router {
  const router = Router();

  // GET /ruta-admin/audit-events
  router.get('/', requireAdminRuta, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = rutaAdminAuditQuerySchema.parse(req.query);
      res.json(await service.listGlobal(query));
    } catch (error) {
      next(error);
    }
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json(toApiError('RESOURCE_NOT_FOUND', 'Endpoint no encontrado'));
  });

  return router;
}
