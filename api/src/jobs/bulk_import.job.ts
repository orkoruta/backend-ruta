import { PgBoss, type Job } from 'pg-boss';
import { withTenant } from '@orkoruta/db';
import { env } from '../config/env.js';

export const BULK_IMPORT_JOB = 'bulk_import';

export interface BulkProductRow {
  name: string;
  unit_price: number;
  product_type: 'VENTA_NORMAL' | 'PROMOCION';
  description?: string;
  category_id?: number;
  stock_quantity?: number;
  image_url?: string;
}

export interface BulkImportJobData {
  clientId: number;
  userId: number;
  rows: BulkProductRow[];
}

export interface BulkImportResult {
  created: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
}

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

export function getBoss(): Promise<PgBoss> {
  if (startPromise) return startPromise;

  startPromise = (async () => {
    bossInstance = new PgBoss(env.DATABASE_URL);
    await bossInstance.start();
    await bossInstance.createQueue(BULK_IMPORT_JOB);
    await bossInstance.work<BulkImportJobData, BulkImportResult>(
      BULK_IMPORT_JOB,
      processBulkImportBatch,
    );
    return bossInstance;
  })();

  return startPromise;
}

async function processBulkImportBatch(
  jobs: Job<BulkImportJobData>[],
): Promise<BulkImportResult> {
  const job = jobs[0];
  if (!job) return { created: 0, failed: 0, errors: [] };

  const { clientId, rows } = job.data;
  let created = 0;
  const errors: BulkImportResult['errors'] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      await withTenant(clientId, 'ADMIN_CLIENT', (tx) =>
        tx.products.create({
          data: {
            client_id: BigInt(clientId),
            name: row.name,
            description: row.description ?? null,
            product_type: row.product_type,
            unit_price: row.unit_price,
            currency: 'COP',
            category_id: row.category_id ? BigInt(row.category_id) : null,
            stock_quantity: row.stock_quantity ?? null,
            image_url: row.image_url ?? null,
            status: 'ACTIVE',
          },
        })
      );
      created++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      // i+2: +1 for header row, +1 for 1-based indexing
      errors.push({ row: i + 2, message });
    }
  }

  return { created, failed: errors.length, errors };
}
