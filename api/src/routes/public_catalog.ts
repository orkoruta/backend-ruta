import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { withTenantReadOnly } from '@orkoruta/db';
import { HttpError } from '../lib/http_error.js';

const slugParamsSchema = z.object({
  slug: z.string().min(1),
});

const publicProductListQuerySchema = z.object({
  category_id: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['name', 'price_asc', 'price_desc']).optional(),
});

async function resolveClientBySlug(slug: string) {
  const client = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, description: true, logo_url: true, status: true, client_type: true, frontend_mode: true },
    })
  );

  if (!client || client.status !== 'ACTIVE') {
    throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Cliente no encontrado');
  }

  return client;
}

export function createPublicCatalogRouter(): Router {
  const router = Router({ mergeParams: true });

  // Bug fix 1: endpoint raíz faltante — retorna info pública del cliente
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const client = await resolveClientBySlug(slug);

      res.json({
        id: Number(client.id),
        name: client.name,
        slug: client.slug,
        description: client.description,
        logo_url: client.logo_url,
        frontend_mode: client.frontend_mode,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      // Bug fix 2+3: query params renombrados (search, limit) y respuesta usa 'data'+'limit'
      const query = publicProductListQuerySchema.parse(req.query);
      const client = await resolveClientBySlug(slug);
      const clientId = Number(client.id);

      const skip = (query.page - 1) * query.limit;

      const sortOrder: Record<string, object> = {
        name: { name: 'asc' },
        price_asc: { unit_price: 'asc' },
        price_desc: { unit_price: 'desc' },
      };

      const where = {
        client_id: BigInt(clientId),
        status: 'ACTIVE',
        ...(query.category_id ? { category_id: BigInt(query.category_id) } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' as const } },
                { description: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };

      const [items, total] = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        Promise.all([
          tx.products.findMany({
            where,
            orderBy: query.sort ? sortOrder[query.sort] : { created_at: 'desc' },
            skip,
            take: query.limit,
            select: { id: true, name: true, description: true, unit_price: true, currency: true, category_id: true, image_url: true, product_type: true },
          }),
          tx.products.count({ where }),
        ])
      );

      res.json({
        data: items.map((p) => ({
          id: Number(p.id),
          name: p.name,
          description: p.description,
          unit_price: Number(p.unit_price),
          currency: p.currency,
          category_id: p.category_id ? Number(p.category_id) : null,
          image_url: p.image_url,
          product_type: p.product_type,
        })),
        pagination: { page: query.page, limit: query.limit, total },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/products/:productId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const productId = parseInt(req.params.productId, 10);
      if (isNaN(productId)) throw new HttpError(400, 'VALIDATION_ERROR', 'ID de producto inválido');

      const client = await resolveClientBySlug(slug);
      const clientId = Number(client.id);

      const product = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        tx.products.findFirst({
          where: { id: BigInt(productId), client_id: BigInt(clientId), status: 'ACTIVE' },
          select: { id: true, name: true, description: true, unit_price: true, currency: true, category_id: true, image_url: true, product_type: true },
        })
      );

      if (!product) throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Producto no encontrado');

      res.json({
        id: Number(product.id),
        name: product.name,
        description: product.description,
        unit_price: Number(product.unit_price),
        currency: product.currency,
        category_id: product.category_id ? Number(product.category_id) : null,
        image_url: product.image_url,
        product_type: product.product_type,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const client = await resolveClientBySlug(slug);
      const clientId = Number(client.id);

      const items = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        tx.product_categories.findMany({
          where: { client_id: BigInt(clientId), status: 'ACTIVE' },
          orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }],
          select: { id: true, name: true, parent_category_id: true },
        })
      );

      // Retorna array directo (no paginado) — el frontend espera Category[]
      res.json(
        items.map((c) => ({
          id: Number(c.id),
          name: c.name,
          parent_id: c.parent_category_id ? Number(c.parent_category_id) : null,
        }))
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/pickup-points', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const client = await resolveClientBySlug(slug);
      const clientId = Number(client.id);

      const items = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
        tx.pickup_points.findMany({
          where: { client_id: BigInt(clientId), status: 'ACTIVE' },
          orderBy: { created_at: 'asc' },
          select: {
            id: true,
            name: true,
            address_line: true,
            city: true,
            latitude: true,
            longitude: true,
          },
        })
      );

      // Retorna array directo — el frontend espera PickupPoint[]
      res.json(
        items.map((p) => ({
          id: Number(p.id),
          name: p.name,
          address: `${p.address_line}, ${p.city}`,
          latitude: p.latitude ? Number(p.latitude) : null,
          longitude: p.longitude ? Number(p.longitude) : null,
        }))
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const publicCatalogRouter = createPublicCatalogRouter();
