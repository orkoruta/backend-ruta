import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../lib/http_error.js';

const slugParamsSchema = z.object({
  slug: z.string().min(1),
});

const publicProductListQuerySchema = z.object({
  category_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

const publicCategoryListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});

const publicPickupPointListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});

async function resolveClientBySlug(slug: string) {
  const client = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findUnique({
      where: { slug },
      select: { id: true, status: true, client_type: true, frontend_mode: true },
    })
  );

  if (!client || client.status !== 'ACTIVE') {
    throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
  }

  return client;
}

export function createPublicCatalogRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const query = publicProductListQuerySchema.parse(req.query);
      const client = await resolveClientBySlug(slug);
      const clientId = Number(client.id);

      const skip = (query.page - 1) * query.page_size;
      const where = {
        status: 'ACTIVE',
        ...(query.category_id ? { category_id: BigInt(query.category_id) } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q } },
                { description: { contains: query.q } },
              ],
            }
          : {}),
      };

      const [items, total] = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        Promise.all([
          tx.products.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip,
            take: query.page_size,
            select: { id: true, name: true, description: true, unit_price: true, currency: true, category_id: true, image_url: true, product_type: true },
          }),
          tx.products.count({ where }),
        ])
      );

      res.json({
        items: items.map((p) => ({
          id: Number(p.id),
          name: p.name,
          description: p.description,
          unit_price: Number(p.unit_price),
          currency: p.currency,
          category_id: p.category_id ? Number(p.category_id) : null,
          image_url: p.image_url,
          product_type: p.product_type,
        })),
        pagination: { page: query.page, page_size: query.page_size, total },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const query = publicCategoryListQuerySchema.parse(req.query);
      const client = await resolveClientBySlug(slug);
      const clientId = Number(client.id);

      const skip = (query.page - 1) * query.page_size;
      const where = { status: 'ACTIVE' };

      const [items, total] = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        Promise.all([
          tx.product_categories.findMany({
            where,
            orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }],
            skip,
            take: query.page_size,
            select: { id: true, name: true, parent_category_id: true, display_order: true },
          }),
          tx.product_categories.count({ where }),
        ])
      );

      res.json({
        items: items.map((c) => ({
          id: Number(c.id),
          name: c.name,
          parent_category_id: c.parent_category_id ? Number(c.parent_category_id) : null,
          sort_order: c.display_order ?? 0,
        })),
        pagination: { page: query.page, page_size: query.page_size, total },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/pickup-points', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const query = publicPickupPointListQuerySchema.parse(req.query);
      const client = await resolveClientBySlug(slug);
      const clientId = Number(client.id);

      const skip = (query.page - 1) * query.page_size;
      const where = { status: 'ACTIVE' };

      const [items, total] = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        Promise.all([
          tx.pickup_points.findMany({
            where,
            orderBy: { created_at: 'asc' },
            skip,
            take: query.page_size,
            select: {
              id: true,
              name: true,
              address_line: true,
              city: true,
              state: true,
              country: true,
              postal_code: true,
              latitude: true,
              longitude: true,
              opening_hours: true,
              contact_phone: true,
            },
          }),
          tx.pickup_points.count({ where }),
        ])
      );

      res.json({
        items: items.map((p) => ({
          id: Number(p.id),
          name: p.name,
          address_line: p.address_line,
          city: p.city,
          state: p.state,
          country: p.country,
          postal_code: p.postal_code,
          latitude: p.latitude ? Number(p.latitude) : null,
          longitude: p.longitude ? Number(p.longitude) : null,
          opening_hours: p.opening_hours,
          contact_phone: p.contact_phone,
        })),
        pagination: { page: query.page, page_size: query.page_size, total },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const publicCatalogRouter = createPublicCatalogRouter();
