import { withTenant, withTenantReadOnly, type TenantTransactionClient } from '@orkoruta/db';
import { z } from 'zod';
import {
  createClientSchema,
  clientIdParamsSchema,
  clientListQuerySchema,
  updateClientSchema,
} from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

/* Definidos una sola vez en `@orkoruta/shared`; se reexportan para las rutas. */
export { clientListQuerySchema, updateClientSchema };

const clientStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
const frontendModeSchema = z.enum(['NATIVE_RUTA', 'CUSTOM_LANDING_BY_RUTA']);



type ClientListQuery = z.infer<typeof clientListQuerySchema>;
type CreateClientInput = z.infer<typeof createClientSchema>;
type UpdateClientInput = z.infer<typeof updateClientSchema>;

interface RequestContext {
  user: AuthenticatedUser;
  ip?: string;
  userAgent?: string;
}

type ClientRow = {
  id: bigint;
  business_code: string;
  slug: string;
  name: string;
  description: string | null;
  client_type: string;
  frontend_mode: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

function serializeClient(client: ClientRow) {
  return {
    id: Number(client.id),
    business_code: client.business_code,
    slug: client.slug,
    name: client.name,
    description: client.description,
    client_type: client.client_type,
    frontend_mode: client.frontend_mode,
    status: client.status,
    created_at: client.created_at.toISOString(),
    updated_at: client.updated_at.toISOString(),
  };
}

function assertFrontendMode(clientType: string, frontendMode?: string | null): string | null {
  if (clientType === 'FULL' && !frontendMode) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Cliente FULL requiere frontend_mode');
  }

  if (clientType === 'API' && frontendMode) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Cliente API no acepta frontend_mode');
  }

  return clientType === 'API' ? null : frontendMode ?? null;
}

function mapPrismaError(error: unknown): never {
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Cliente con business_code o slug ya existe');
  }

  throw error;
}

async function auditClientAction(
  tx: TenantTransactionClient,
  action: string,
  entityId: bigint | null,
  ctx: RequestContext,
  metadata?: Record<string, unknown>
) {
  await tx.audit_events.create({
    data: {
      client_id: BigInt(0),
      actor_user_id: BigInt(ctx.user.id),
      actor_type: 'USER',
      actor_role: ctx.user.user_type,
      action,
      entity_type: 'client',
      entity_id: entityId,
      ip_address: ctx.ip,
      user_agent: ctx.userAgent,
      metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
      result: 'SUCCESS',
    },
  });
}

export const clientsService = {
  async list(query: ClientListQuery) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.client_type ? { client_type: query.client_type } : {}),
      ...(query.q
        ? {
            OR: [
              { business_code: { contains: query.q } },
              { slug: { contains: query.q } },
              { name: { contains: query.q } },
            ],
          }
        : {}),
    };

    const skip = (query.page - 1) * query.page_size;

    const [items, total] = await withTenantReadOnly(0, 'ADMIN_RUTA', async (tx) => Promise.all([
      tx.clients.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: query.page_size,
      }),
      tx.clients.count({ where }),
    ]));

    return {
      data: items.map(serializeClient),
      pagination: {
        page: query.page,
        page_size: query.page_size,
        total,
      },
    };
  },

  async getById(clientId: number) {
    const client = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) => tx.clients.findUnique({
      where: { id: BigInt(clientId) },
    }));

    if (!client) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
    }

    return serializeClient(client);
  },

  async create(input: CreateClientInput, ctx: RequestContext) {
    const frontendMode = assertFrontendMode(input.client_type, input.frontend_mode);

    try {
      const client = await withTenant(0, 'ADMIN_RUTA', async (tx) => {
        const created = await tx.clients.create({
          data: {
            business_code: input.business_code,
            slug: input.slug,
            name: input.name,
            description: input.description,
            client_type: input.client_type,
            frontend_mode: frontendMode,
            status: 'ACTIVE',
          },
        });

        await auditClientAction(tx, 'CLIENT_CREATED', created.id, ctx, {
          slug: created.slug,
          client_type: created.client_type,
          frontend_mode: created.frontend_mode,
        });

        return created;
      });

      return serializeClient(client);
    } catch (error) {
      mapPrismaError(error);
    }
  },

  async update(clientId: number, input: UpdateClientInput, ctx: RequestContext) {
    try {
      const client = await withTenant(0, 'ADMIN_RUTA', async (tx) => {
        const current = await tx.clients.findUnique({ where: { id: BigInt(clientId) } });
        if (!current) {
          throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
        }

        const nextClientType = input.client_type ?? current.client_type;
        const nextFrontendMode = assertFrontendMode(
          nextClientType,
          input.frontend_mode !== undefined ? input.frontend_mode : current.frontend_mode
        );

        const updated = await tx.clients.update({
          where: { id: BigInt(clientId) },
          data: {
            ...(input.business_code !== undefined ? { business_code: input.business_code } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.client_type !== undefined ? { client_type: input.client_type } : {}),
            frontend_mode: nextFrontendMode,
            ...(input.status !== undefined ? { status: input.status } : {}),
            updated_at: new Date(),
          },
        });

        await auditClientAction(tx, 'CLIENT_UPDATED', updated.id, ctx, {
          changed_fields: Object.keys(input),
        });

        return updated;
      });

      return serializeClient(client);
    } catch (error) {
      mapPrismaError(error);
    }
  },

  async activate(clientId: number, ctx: RequestContext) {
    return this.update(clientId, { status: 'ACTIVE' }, ctx);
  },

  async deactivate(clientId: number, ctx: RequestContext) {
    return this.update(clientId, { status: 'INACTIVE' }, ctx);
  },

  async purge(clientId: number, ctx: RequestContext) {
    const parsed = clientIdParamsSchema.parse({ client_id: clientId });

    const deleted = await withTenant(0, 'ADMIN_RUTA', async (tx) => {
      const current = await tx.clients.findUnique({ where: { id: BigInt(parsed.client_id) } });
      if (!current) {
        throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
      }

      if (current.status !== 'INACTIVE') {
        throw new HttpError(422, 'INVALID_STATE_TRANSITION', 'Cliente debe estar INACTIVE para eliminarse');
      }

      await tx.$executeRaw`SELECT ruta.purge_client_data(${BigInt(parsed.client_id)}, ${BigInt(ctx.user.id)})`;

      return current;
    });

    return serializeClient(deleted);
  },
};
