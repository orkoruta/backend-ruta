import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAdminClient } from '../middleware/auth.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { bulkImportService } from '../services/bulk_import.service.js';
import type { BulkImportService } from '../services/bulk_import.service.js';
import { toApiError } from '../lib/errors.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const jobIdParamsSchema = z.object({
  job_id: z.string().uuid('job_id debe ser un UUID válido'),
});

export function createAdminProductsBulkRouter(
  service: BulkImportService = bulkImportService,
): Router {
  const router = Router();

  router.use(requireAdminClient);
  router.use(requireIdempotencyKey);

  router.post(
    '/',
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.file) {
          res.status(400).json(toApiError('VALIDATION_ERROR', 'Se requiere un archivo Excel en el campo "file"'));
          return;
        }

        const ext = req.file.originalname.split('.').pop()?.toLowerCase();
        if (ext !== 'xlsx') {
          res.status(400).json(toApiError('VALIDATION_ERROR', 'Solo se aceptan archivos .xlsx'));
          return;
        }

        const result = await service.startImport(req.user!.client_id, req.file.buffer, req.user!);
        res.status(202).json({
          ...result,
          message: `Importación iniciada. Consulta el estado con GET /admin/products/bulk-import/${result.job_id}`,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/:job_id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { job_id } = jobIdParamsSchema.parse(req.params);
      const status = await service.getJobStatus(req.user!.client_id, job_id);
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminProductsBulkRouter = createAdminProductsBulkRouter();
