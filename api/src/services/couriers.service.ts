import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { z } from 'zod';
import { createCourierSchema, courierIdParamsSchema } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import { hashPassword } from '../lib/password.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

export const courierListQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateCourierSchema = z.object({
  full_name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(30).optional(),
  document_type: z.string().min(1).max(10).optional(),
  document_number: z.string().min(1).max(50).optional(),
  transport_mode: z.string().optional(),
  vehicle_plate: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
});

type CourierListQuery = z.infer<typeof courierListQuerySchema>;
type CreateCourierInput = z.infer<typeof createCourierSchema>;
type UpdateCourierInput = z.infer<typeof updateCourierSchema>;

interface RequestContext {
  user: AuthenticatedUser;
  ip?: string;
  userAgent?: string;
}

function serializeCourier(user: {
  id: bigint;
  client_id: bigint;
  email: string;
  full_name: string | null;
  phone: string | null;
  document_type: string | null;
  document_number: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  courier_profiles: {
    transport_method: string | null;
    vehicle_plate: string | null;
    additional_data: unknown;
  } | null;
}) {
  return {
    id: Number(user.id),
    client_id: Number(user.client_id),
    email: user.email,
    full_name: user.full_name,
    phone: user.phone,
    document_type: user.document_type,
    document_number: user.document_number,
    status: user.status,
    profile: user.courier_profiles
      ? {
          transport_mode: user.courier_profiles.transport_method,
          vehicle_plate: user.courier_profiles.vehicle_plate,
        }
      : null,
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
  };
}

const courierInclude = {
  courier_profiles: {
    select: {
      transport_method: true,
      vehicle_plate: true,
      additional_data: true,
    },
  },
} as const;

export const couriersService = {
  async list(clientId: number, query: CourierListQuery) {
    const where = {
      user_type: 'COURIER',
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q } },
              { full_name: { contains: query.q } },
              { phone: { contains: query.q } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.page_size;

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.users.findMany({
          where,
          include: courierInclude,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.users.count({ where }),
      ])
    );

    return {
      items: items.map(serializeCourier),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  async getById(clientId: number, courierUserId: number) {
    const user = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.users.findUnique({
        where: { id_client_id: { id: BigInt(courierUserId), client_id: BigInt(clientId) } },
        include: courierInclude,
      })
    );

    if (!user || user.user_type !== 'COURIER') {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Repartidor no encontrado');
    }

    return serializeCourier(user);
  },

  async create(clientId: number, input: CreateCourierInput, _ctx: RequestContext) {
    const passwordHash = await hashPassword(input.password);

    const user = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      const existing = await tx.users.findUnique({
        where: { client_id_email: { client_id: BigInt(clientId), email: input.email } },
      });
      if (existing) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Email ya registrado');
      }

      const created = await tx.users.create({
        data: {
          client_id: BigInt(clientId),
          user_type: 'COURIER',
          email: input.email,
          password_hash: passwordHash,
          full_name: input.full_name,
          phone: input.phone,
          document_type: input.document_type,
          document_number: input.document_number,
          status: 'ACTIVE',
        },
      });

      await tx.courier_profiles.create({
        data: {
          user_id: created.id,
          client_id: BigInt(clientId),
          transport_method: input.transport_mode,
        },
      });

      return tx.users.findUnique({
        where: { id_client_id: { id: created.id, client_id: BigInt(clientId) } },
        include: courierInclude,
      });
    }).catch((err: unknown) => {
      if (typeof err === 'object' && err && 'code' in err && (err as { code: string }).code === 'P2002') {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Email ya registrado');
      }
      throw err;
    });

    return serializeCourier(user!);
  },

  async update(clientId: number, courierUserId: number, input: UpdateCourierInput, _ctx: RequestContext) {
    const existing = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.users.findUnique({
        where: { id_client_id: { id: BigInt(courierUserId), client_id: BigInt(clientId) } },
      })
    );

    if (!existing || existing.user_type !== 'COURIER') {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Repartidor no encontrado');
    }

    const user = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      await tx.users.update({
        where: { id_client_id: { id: BigInt(courierUserId), client_id: BigInt(clientId) } },
        data: {
          ...(input.full_name !== undefined ? { full_name: input.full_name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.document_type !== undefined ? { document_type: input.document_type } : {}),
          ...(input.document_number !== undefined ? { document_number: input.document_number } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updated_at: new Date(),
        },
      });

      if (input.transport_mode !== undefined || input.vehicle_plate !== undefined) {
        await tx.courier_profiles.update({
          where: { user_id_client_id: { user_id: BigInt(courierUserId), client_id: BigInt(clientId) } },
          data: {
            ...(input.transport_mode !== undefined ? { transport_method: input.transport_mode } : {}),
            ...(input.vehicle_plate !== undefined ? { vehicle_plate: input.vehicle_plate } : {}),
          },
        });
      }

      return tx.users.findUnique({
        where: { id_client_id: { id: BigInt(courierUserId), client_id: BigInt(clientId) } },
        include: courierInclude,
      });
    });

    return serializeCourier(user!);
  },

  async activate(clientId: number, courierUserId: number, ctx: RequestContext) {
    return this.update(clientId, courierUserId, { status: 'ACTIVE' }, ctx);
  },

  async deactivate(clientId: number, courierUserId: number, ctx: RequestContext) {
    return this.update(clientId, courierUserId, { status: 'INACTIVE' }, ctx);
  },
};

export { courierIdParamsSchema };
