import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { z } from 'zod';
import { createProductSchema, productIdParamsSchema,
  updateProductSchema,
} from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { productListQuerySchema } from '@orkoruta/shared';

/*
 * Definido una sola vez en `@orkoruta/shared` y reexportado aquí: antes había
 * una copia local que podía divergir —y divergía— del contrato publicado.
 */
export { productListQuerySchema };


/*
 * Definido una sola vez en `@orkoruta/shared` y reexportado aquí: una copia
 * local puede divergir del contrato publicado, y esta divergía.
 */
export { updateProductSchema };

type ProductListQuery = z.infer<typeof productListQuerySchema>;
type CreateProductInput = z.infer<typeof createProductSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;

interface RequestContext {
  user: AuthenticatedUser;
  ip?: string;
  userAgent?: string;
}

type ProductRow = {
  id: bigint;
  client_id: bigint;
  sku: string | null;
  name: string;
  description: string | null;
  product_type: string;
  unit_price: { toNumber(): number } | number;
  currency: string;
  category_id: bigint | null;
  image_url: string | null;
  status: string;
  stock_quantity: number | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
};

function serializeProduct(row: ProductRow) {
  return {
    id: Number(row.id),
    client_id: Number(row.client_id),
    sku: row.sku,
    name: row.name,
    description: row.description,
    product_type: row.product_type,
    unit_price: typeof row.unit_price === 'number' ? row.unit_price : row.unit_price.toNumber(),
    currency: row.currency,
    category_id: row.category_id ? Number(row.category_id) : null,
    image_url: row.image_url,
    status: row.status,
    stock_quantity: row.stock_quantity,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function mapPrismaError(error: unknown): never {
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Producto con SKU ya existe');
  }
  throw error;
}

export const productsService = {
  async list(clientId: number, query: ProductListQuery) {
    const where = {
      client_id: BigInt(clientId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category_id ? { category_id: BigInt(query.category_id) } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q } },
              { sku: { contains: query.q } },
              { description: { contains: query.q } },
            ],
          }
        : {}),
    };
    const skip = (query.page - 1) * query.page_size;

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.products.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: query.page_size,
        }),
        tx.products.count({ where }),
      ])
    );

    return {
      data: items.map(serializeProduct),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  async getById(clientId: number, productId: number) {
    const row = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.products.findUnique({
        where: { id_client_id: { id: BigInt(productId), client_id: BigInt(clientId) } },
      })
    );

    if (!row) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Producto no encontrado');
    }

    return serializeProduct(row);
  },

  async create(clientId: number, input: CreateProductInput, _ctx: RequestContext) {
    try {
      const row = await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.products.create({
          data: {
            client_id: BigInt(clientId),
            name: input.name,
            description: input.description,
            product_type: input.product_type,
            unit_price: input.unit_price,
            currency: input.currency ?? 'COP',
            category_id: input.category_id ? BigInt(input.category_id) : null,
            stock_quantity: input.stock_quantity,
            status: 'ACTIVE',
          },
        })
      );
      return serializeProduct(row);
    } catch (error) {
      mapPrismaError(error);
    }
  },

  async update(clientId: number, productId: number, input: UpdateProductInput, _ctx: RequestContext) {
    const current = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.products.findUnique({
        where: { id_client_id: { id: BigInt(productId), client_id: BigInt(clientId) } },
      })
    );

    if (!current) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Producto no encontrado');
    }

    try {
      const row = await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.products.update({
          where: { id_client_id: { id: BigInt(productId), client_id: BigInt(clientId) } },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.product_type !== undefined ? { product_type: input.product_type } : {}),
            ...(input.unit_price !== undefined ? { unit_price: input.unit_price } : {}),
            ...(input.currency !== undefined ? { currency: input.currency } : {}),
            ...(input.category_id !== undefined ? { category_id: input.category_id ? BigInt(input.category_id) : null } : {}),
            ...(input.stock_quantity !== undefined ? { stock_quantity: input.stock_quantity } : {}),
            ...(input.image_url !== undefined ? { image_url: input.image_url } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            updated_at: new Date(),
          },
        })
      );
      return serializeProduct(row);
    } catch (error) {
      mapPrismaError(error);
    }
  },

  async activate(clientId: number, productId: number, ctx: RequestContext) {
    return this.update(clientId, productId, { status: 'ACTIVE' }, ctx);
  },

  async deactivate(clientId: number, productId: number, ctx: RequestContext) {
    return this.update(clientId, productId, { status: 'INACTIVE' }, ctx);
  },
};

export { productIdParamsSchema };
