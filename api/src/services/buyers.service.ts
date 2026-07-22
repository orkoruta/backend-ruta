import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { z } from 'zod';
import { buyerIdParamsSchema } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import { hashPassword } from '../lib/password.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

export const buyerListQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const createBuyerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  full_name: z.string().min(1).max(200),
  phone: z.string().min(1).max(30).optional(),
  document_type: z.string().min(1).max(10).optional(),
  document_number: z.string().min(1).max(50).optional(),
});

export const updateBuyerSchema = z.object({
  full_name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(30).optional(),
  document_type: z.string().min(1).max(10).optional(),
  document_number: z.string().min(1).max(50).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
});

type BuyerListQuery = z.infer<typeof buyerListQuerySchema>;
type CreateBuyerInput = z.infer<typeof createBuyerSchema>;
type UpdateBuyerInput = z.infer<typeof updateBuyerSchema>;

interface RequestContext {
  user: AuthenticatedUser;
  ip?: string;
  userAgent?: string;
}

function serializeBuyer(user: {
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
  buyer_profiles: {
    default_address_line: string | null;
    default_address_city: string | null;
    default_address_state: string | null;
    default_address_country: string | null;
    default_address_postal_code: string | null;
    buyer_type: string;
    corporate_name: string | null;
    corporate_tax_id: string | null;
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
    profile: user.buyer_profiles
      ? {
          buyer_type: user.buyer_profiles.buyer_type,
          corporate_name: user.buyer_profiles.corporate_name,
          corporate_tax_id: user.buyer_profiles.corporate_tax_id,
          default_address_line: user.buyer_profiles.default_address_line,
          default_address_city: user.buyer_profiles.default_address_city,
          default_address_state: user.buyer_profiles.default_address_state,
          default_address_country: user.buyer_profiles.default_address_country,
          default_address_postal_code: user.buyer_profiles.default_address_postal_code,
        }
      : null,
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
  };
}

const buyerInclude = {
  buyer_profiles: {
    select: {
      buyer_type: true,
      corporate_name: true,
      corporate_tax_id: true,
      default_address_line: true,
      default_address_city: true,
      default_address_state: true,
      default_address_country: true,
      default_address_postal_code: true,
    },
  },
} as const;

export const buyersService = {
  async list(clientId: number, query: BuyerListQuery) {
    const where = {
      client_id: BigInt(clientId),
      user_type: 'BUYER',
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q } },
              { full_name: { contains: query.q } },
              { document_number: { contains: query.q } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.page_size;

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.users.findMany({
          where,
          include: buyerInclude,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.users.count({ where }),
      ])
    );

    return {
      data: items.map(serializeBuyer),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  async getById(clientId: number, buyerUserId: number) {
    const user = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.users.findUnique({
        where: { id_client_id: { id: BigInt(buyerUserId), client_id: BigInt(clientId) } },
        include: buyerInclude,
      })
    );

    if (!user || user.user_type !== 'BUYER') {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Comprador no encontrado');
    }

    return serializeBuyer(user);
  },

  async create(clientId: number, input: CreateBuyerInput, _ctx: RequestContext) {
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
          user_type: 'BUYER',
          email: input.email,
          password_hash: passwordHash,
          full_name: input.full_name,
          phone: input.phone,
          document_type: input.document_type,
          document_number: input.document_number,
          status: 'ACTIVE',
        },
      });

      await tx.buyer_profiles.create({
        data: {
          user_id: created.id,
          client_id: BigInt(clientId),
        },
      });

      return tx.users.findUnique({
        where: { id_client_id: { id: created.id, client_id: BigInt(clientId) } },
        include: buyerInclude,
      });
    }).catch((err: unknown) => {
      if (typeof err === 'object' && err && 'code' in err && (err as { code: string }).code === 'P2002') {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Email ya registrado');
      }
      throw err;
    });

    return serializeBuyer(user!);
  },

  async update(clientId: number, buyerUserId: number, input: UpdateBuyerInput, _ctx: RequestContext) {
    const existing = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.users.findUnique({
        where: { id_client_id: { id: BigInt(buyerUserId), client_id: BigInt(clientId) } },
      })
    );

    if (!existing || existing.user_type !== 'BUYER') {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Comprador no encontrado');
    }

    const user = await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
      await tx.users.update({
        where: { id_client_id: { id: BigInt(buyerUserId), client_id: BigInt(clientId) } },
        data: {
          ...(input.full_name !== undefined ? { full_name: input.full_name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.document_type !== undefined ? { document_type: input.document_type } : {}),
          ...(input.document_number !== undefined ? { document_number: input.document_number } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updated_at: new Date(),
        },
      });

      return tx.users.findUnique({
        where: { id_client_id: { id: BigInt(buyerUserId), client_id: BigInt(clientId) } },
        include: buyerInclude,
      });
    });

    return serializeBuyer(user!);
  },

  async activate(clientId: number, buyerUserId: number, ctx: RequestContext) {
    return this.update(clientId, buyerUserId, { status: 'ACTIVE' }, ctx);
  },

  async deactivate(clientId: number, buyerUserId: number, ctx: RequestContext) {
    return this.update(clientId, buyerUserId, { status: 'INACTIVE' }, ctx);
  },
};

export { buyerIdParamsSchema };
