import * as XLSX from 'xlsx';
import { z } from 'zod';
import { getBoss, BULK_IMPORT_JOB, type BulkProductRow, type BulkImportJobData, type BulkImportResult } from '../jobs/bulk_import.job.js';
import { HttpError } from '../lib/http_error.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

const bulkProductRowSchema = z.object({
  name: z.string().min(1).max(300),
  unit_price: z.coerce.number().int().positive(),
  product_type: z.enum(['VENTA_NORMAL', 'PROMOCION']),
  description: z.string().optional(),
  category_id: z.coerce.number().int().positive().optional(),
  stock_quantity: z.coerce.number().int().min(0).optional(),
  image_url: z.string().url().optional(),
});

export type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';

export interface BulkImportJobStatus {
  job_id: string;
  status: JobStatus;
  result?: BulkImportResult;
  error?: string;
}

function parseExcelBuffer(buffer: Buffer): BulkProductRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'El archivo Excel está vacío');
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  if (rawRows.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'El archivo no contiene filas de datos');
  }

  if (rawRows.length > 1000) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'El archivo no puede contener más de 1000 filas');
  }

  const rows: BulkProductRow[] = [];
  const validationErrors: string[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const parsed = bulkProductRowSchema.safeParse(rawRows[i]);
    if (!parsed.success) {
      validationErrors.push(`Fila ${i + 2}: ${parsed.error.errors.map((e) => e.message).join(', ')}`);
    } else {
      rows.push(parsed.data as BulkProductRow);
    }
  }

  if (validationErrors.length > 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Errores en el archivo: ${validationErrors.slice(0, 5).join('; ')}`);
  }

  return rows;
}

function mapBossState(state: string): JobStatus {
  if (state === 'created' || state === 'retry') return 'pending';
  if (state === 'active') return 'active';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  return 'cancelled';
}

export const bulkImportService = {
  async startImport(
    clientId: number,
    fileBuffer: Buffer,
    user: AuthenticatedUser,
  ): Promise<{ job_id: string; status: 'pending' }> {
    const rows = parseExcelBuffer(fileBuffer);
    const boss = await getBoss();

    const data: BulkImportJobData = {
      clientId,
      userId: user.id,
      rows,
    };

    const jobId = await boss.send(BULK_IMPORT_JOB, data);
    if (!jobId) {
      throw new HttpError(500, 'TENANT_ISOLATION_VIOLATION', 'No se pudo encolar el trabajo de importación');
    }

    return { job_id: jobId, status: 'pending' };
  },

  async getJobStatus(clientId: number, jobId: string): Promise<BulkImportJobStatus> {
    const boss = await getBoss();
    const job = await boss.getJobById<BulkImportJobData>(BULK_IMPORT_JOB, jobId);

    if (!job) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Trabajo de importación no encontrado');
    }

    // tenant isolation: verify the job belongs to this client
    if (job.data.clientId !== clientId) {
      throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Trabajo de importación no encontrado');
    }

    const status = mapBossState(job.state);
    const result = status === 'completed' ? (job.output as BulkImportResult | undefined) : undefined;

    return {
      job_id: job.id,
      status,
      ...(result ? { result } : {}),
    };
  },
};

export type BulkImportService = typeof bulkImportService;
