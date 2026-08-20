import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { z } from 'zod';
import { HttpError } from '../lib/http_error.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import {
  pickupPointListQuerySchema,
  createPickupPointSchema,
  updatePickupPointSchema,
  pickupPointIdParamsSchema,
} from '@orkoruta/shared';

// ── Schemas ───────────────────────────────────────────────────────────────────
//
// Definidos en `@orkoruta/shared` (una sola vez) y reexportados aquí para no
// tocar las rutas que ya los importaban de este módulo.

export {
  pickupPointListQuerySchema,
  createPickupPointSchema,
  updatePickupPointSchema,
  pickupPointIdParamsSchema,
};

// ── Types ─────────────────────────────────────────────────────────────────────

type PickupPointListQuery = z.infer<typeof pickupPointListQuerySchema>;
type CreatePickupPointInput = z.infer<typeof createPickupPointSchema>;
type UpdatePickupPointInput = z.infer<typeof updatePickupPointSchema>;

interface RequestContext {
  user: AuthenticatedUser;
  ip?: string;
  userAgent?: string;
}

// ── Serializer ────────────────────────────────────────────────────────────────

function serializePickupPoint(pp: {
  id: bigint;
  client_id: bigint;
  name: string;
  address_line: string;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  latitude: unknown;
  longitude: unknown;
  opening_hours: unknown;
  contact_phone: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: Number(pp.id),
    client_id: Number(pp.client_id),
    name: pp.name,
    address_line: pp.address_line,
    city: pp.city,
    state: pp.state,
    country: pp.country,
    postal_code: pp.postal_code,
    latitude: pp.latitude !== null && pp.latitude !== undefined ? Number(pp.latitude) : null,
    longitude: pp.longitude !== null && pp.longitude !== undefined ? Number(pp.longitude) : null,
    opening_hours: pp.opening_hours ?? null,
    contact_phone: pp.contact_phone,
    status: pp.status,
    created_at: pp.created_at.toISOString(),
    updated_at: pp.updated_at.toISOString(),
  };
}

// ── Audit helper ──────────────────────────────────────────────────────────────

async function auditPickupPointAction(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  clientId: number,
  action: string,
  entityId: bigint,
  ctx: RequestContext,
  metadata?: Record<string, unknown>
) {
  await tx.audit_events.create({
    data: {
      client_id: BigInt(clientId),
      actor_user_id: BigInt(ctx.user.id),
      actor_type: 'USER',
      actor_role: ctx.user.user_type,
      action,
      entity_type: 'pickup_point',
      entity_id: entityId,
      ip_address: ctx.ip,
      user_agent: ctx.userAgent,
      metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
      result: 'SUCCESS',
    },
  });
}

// ── Service ───────────────────────────────────────────────────────────────────

export const pickupPointsService = {
  async list(clientId: number, query: PickupPointListQuery) {
    const where = {
      client_id: BigInt(clientId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { address_line: { contains: query.search, mode: 'insensitive' as const } },
              { city: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.page_size;

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.pickup_points.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.pickup_points.count({ where }),
      ])
    );

    return {
      data: items.map(serializePickupPoint),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  async getById(clientId: number, id: number) {
    const pp = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.pickup_points.findUnique({
        where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
      })
    );

    if (!pp) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado');
    }

    return serializePickupPoint(pp);
  },

  async create(clientId: number, input: CreatePickupPointInput, ctx: RequestContext) {
    const pp = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const created = await tx.pickup_points.create({
        data: {
          client_id: BigInt(clientId),
          name: input.name,
          address_line: input.address_line,
          city: input.city,
          state: input.state,
          country: input.country,
          postal_code: input.postal_code,
          latitude: input.latitude !== undefined ? input.latitude : undefined,
          longitude: input.longitude !== undefined ? input.longitude : undefined,
          opening_hours: input.opening_hours !== undefined
            ? (JSON.parse(JSON.stringify(input.opening_hours)) as object)
            : undefined,
          contact_phone: input.contact_phone,
          status: 'ACTIVE',
        },
      });

      await auditPickupPointAction(tx, clientId, 'PICKUP_POINT_CREATED', created.id, ctx, {
        name: input.name,
      });

      return created;
    });

    return serializePickupPoint(pp);
  },

  async update(clientId: number, id: number, input: UpdatePickupPointInput, ctx: RequestContext) {
    const existing = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.pickup_points.findUnique({
        where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
      })
    );

    if (!existing) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado');
    }

    const pp = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const updated = await tx.pickup_points.update({
        where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.address_line !== undefined ? { address_line: input.address_line } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.postal_code !== undefined ? { postal_code: input.postal_code } : {}),
          ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
          ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
          ...(input.opening_hours !== undefined
            ? { opening_hours: JSON.parse(JSON.stringify(input.opening_hours)) as object }
            : {}),
          ...(input.contact_phone !== undefined ? { contact_phone: input.contact_phone } : {}),
          updated_at: new Date(),
        },
      });

      await auditPickupPointAction(tx, clientId, 'PICKUP_POINT_UPDATED', BigInt(id), ctx, {
        changes: Object.keys(input),
      });

      return updated;
    });

    return serializePickupPoint(pp);
  },

  async activate(clientId: number, id: number, ctx: RequestContext) {
    const existing = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.pickup_points.findUnique({
        where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
      })
    );

    if (!existing) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado');
    }

    const pp = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const updated = await tx.pickup_points.update({
        where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
        data: { status: 'ACTIVE', updated_at: new Date() },
      });

      await auditPickupPointAction(tx, clientId, 'PICKUP_POINT_ACTIVATED', BigInt(id), ctx);

      return updated;
    });

    return serializePickupPoint(pp);
  },

  async deactivate(clientId: number, id: number, ctx: RequestContext) {
    const existing = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.pickup_points.findUnique({
        where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
      })
    );

    if (!existing) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Punto de recogida no encontrado');
    }

    const pp = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const updated = await tx.pickup_points.update({
        where: { id_client_id: { id: BigInt(id), client_id: BigInt(clientId) } },
        data: { status: 'INACTIVE', updated_at: new Date() },
      });

      await auditPickupPointAction(tx, clientId, 'PICKUP_POINT_DEACTIVATED', BigInt(id), ctx);

      return updated;
    });

    return serializePickupPoint(pp);
  },
};
