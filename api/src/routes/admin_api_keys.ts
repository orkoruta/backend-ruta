/**
 * admin_api_keys.ts — F2.2.BACK-1
 *
 * Endpoints para gestión de API keys por ADMIN_CLIENT / ADMIN_RUTA.
 *
 * GET    /admin/api-keys        — Listar API keys
 * POST   /admin/api-keys        — Crear API key (devuelve secret UNA SOLA VEZ)
 * DELETE /admin/api-keys/:key_id — Revocar API key
 */

import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { generateApiKey, listApiKeys, revokeApiKey } from '../services/api_keys.service.js';
import { createApiKeySchema, revokeApiKeySchema } from '@orkoruta/shared';

export const adminApiKeysRouter: RouterType = Router();

// GET /admin/api-keys — solo ADMIN_CLIENT / ADMIN_RUTA
adminApiKeysRouter.get(
  '/',
  requireAdminClient,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientId = BigInt(req.user!.client_id);
      const keys = await listApiKeys(clientId);
      res.json({ data: keys });
    } catch (error) {
      next(error);
    }
  },
);

// POST /admin/api-keys — requiere idempotency key
adminApiKeysRouter.post(
  '/',
  requireAdminClient,
  requireIdempotencyKey,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = createApiKeySchema.parse(req.body);
      const clientId = BigInt(req.user!.client_id);
      const actorUserId = BigInt(req.user!.id);

      const result = await generateApiKey(clientId, input, actorUserId);

      // 201 con secret incluido — la única vez que se devuelve
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

// DELETE /admin/api-keys/:key_id — revocar
adminApiKeysRouter.delete(
  '/:key_id',
  requireAdminClient,
  requireIdempotencyKey,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { key_id } = req.params;
      const body = revokeApiKeySchema.safeParse(req.body ?? {});
      const reason = body.success ? body.data.reason : undefined;

      const clientId = BigInt(req.user!.client_id);
      const actorUserId = BigInt(req.user!.id);

      await revokeApiKey(clientId, key_id, reason, actorUserId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);
