import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { z } from 'zod';
import { createCategorySchema, categoryIdParamsSchema,
  updateCategorySchema,
} from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { categoryListQuerySchema } from '@orkoruta/shared';

/*
 * Definido una sola vez en `@orkoruta/shared` y reexportado aquí: antes había
 * una copia local que podía divergir —y divergía— del contrato publicado.
 */
export { categoryListQuerySchema };


/*
 * Definido una sola vez en `@orkoruta/shared` y reexportado aquí: una copia
 * local puede divergir del contrato publicado, y esta divergía.
 */
export { updateCategorySchema };

type CategoryListQuery = z.infer<typeof categoryListQuerySchema>;
type CreateCategoryInput = z.infer<typeof createCategorySchema>;
type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

interface RequestContext {
  user: AuthenticatedUser;
  ip?: string;
  userAgent?: string;
}

type CategoryRow = {
  id: bigint;
  client_id: bigint;
  name: string;
  parent_category_id: bigint | null;
  display_order: number | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

function serializeCategory(row: CategoryRow) {
  return {
    id: Number(row.id),
    client_id: Number(row.client_id),
    name: row.name,
    parent_category_id: row.parent_category_id ? Number(row.parent_category_id) : null,
    sort_order: row.display_order ?? 0,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export const categoriesService = {
  async list(clientId: number, query: CategoryListQuery) {
    const where = {
      client_id: BigInt(clientId),
      ...(query.status ? { status: query.status } : {}),
    };
    const skip = (query.page - 1) * query.page_size;

    const [items, total] = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      Promise.all([
        tx.product_categories.findMany({
          where,
          orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }],
          skip,
          take: query.page_size,
        }),
        tx.product_categories.count({ where }),
      ])
    );

    return {
      data: items.map(serializeCategory),
      pagination: { page: query.page, page_size: query.page_size, total },
    };
  },

  async getById(clientId: number, categoryId: number) {
    const row = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.product_categories.findUnique({
        where: { id_client_id: { id: BigInt(categoryId), client_id: BigInt(clientId) } },
      })
    );

    if (!row) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Categoría no encontrada');
    }

    return serializeCategory(row);
  },

  async create(clientId: number, input: CreateCategoryInput, ctx: RequestContext) {
    const row = await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.product_categories.create({
        data: {
          client_id: BigInt(clientId),
          name: input.name,
          display_order: input.sort_order ?? 0,
          status: 'ACTIVE',
        },
      })
    );

    return serializeCategory(row);
  },

  async update(clientId: number, categoryId: number, input: UpdateCategoryInput, _ctx: RequestContext) {
    const current = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.product_categories.findUnique({
        where: { id_client_id: { id: BigInt(categoryId), client_id: BigInt(clientId) } },
      })
    );

    if (!current) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Categoría no encontrada');
    }

    const row = await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
      tx.product_categories.update({
        where: { id_client_id: { id: BigInt(categoryId), client_id: BigInt(clientId) } },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sort_order !== undefined ? { display_order: input.sort_order } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updated_at: new Date(),
        },
      })
    );

    return serializeCategory(row);
  },

  async activate(clientId: number, categoryId: number, ctx: RequestContext) {
    return this.update(clientId, categoryId, { status: 'ACTIVE' }, ctx);
  },

  async deactivate(clientId: number, categoryId: number, ctx: RequestContext) {
    return this.update(clientId, categoryId, { status: 'INACTIVE' }, ctx);
  },
};

export { categoryIdParamsSchema };
