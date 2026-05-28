import type { PgBoss } from 'pg-boss';
import { withTenantReadOnly } from '@orkoruta/db';
import { getParameterInt } from '../lib/parameter.js';
import { logger } from '../middleware/logger.js';

export const PAYMENT_TIMEOUT_JOB = 'payment_timeout';
const CRON = '*/2 * * * *';

export async function registerPaymentTimeoutJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(PAYMENT_TIMEOUT_JOB);
  await boss.schedule(PAYMENT_TIMEOUT_JOB, CRON);
  await boss.work(PAYMENT_TIMEOUT_JOB, async () => {
    await processPaymentTimeout();
  });
  logger.info({ job: PAYMENT_TIMEOUT_JOB }, 'Job registered');
}

export async function processPaymentTimeout(): Promise<void> {
  // Payment online only applies to FULL clients (Flujo 1, Bloque 3)
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      where: { status: 'ACTIVE', id: { gt: 0n }, client_type: 'FULL' },
      select: { id: true },
    })
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    const timeoutMinutes = await resolveParamInt(
      clientId,
      'order.pending_online_payment_timeout_minutes',
      15,
    );
    await timeoutPendingPayments(clientId, timeoutMinutes);
  }
}

export async function timeoutPendingPayments(
  clientId: number,
  timeoutMinutes: number,
): Promise<void> {
  // submitted_at is set when order moves to ORDER_SUBMITTED (Flujo 1, Bloque 3-1)
  const threshold = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const timedOutOrders = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.orders.findMany({
      where: {
        client_id: BigInt(clientId),
        payment_status: 'PENDING_ONLINE_PAYMENT',
        submitted_at: { lt: threshold, not: null },
      },
      select: { id: true },
    })
  );

  if (timedOutOrders.length === 0) return;

  logger.info(
    { clientId, count: timedOutOrders.length },
    'Orders with PENDING_ONLINE_PAYMENT timed out',
  );

  for (const order of timedOutOrders) {
    // TODO 2.BACK-1: uncomment when api/src/services/orders/state_machine.ts is merged
    // from feat/back-2-1. Replace this block with:
    //   await stateMachine.transition(order.id, clientId, {
    //     type: 'PAYMENT_TIMEOUT',
    //     actor: 'SYSTEM',
    //     closureReason: 'PAYMENT_TIMEOUT',
    //   });
    logger.warn(
      { orderId: String(order.id), clientId },
      'Payment timed out — awaiting state_machine (2.BACK-1)',
    );
  }
}

// Looks up client-specific param first, then falls back to global (client_id=0) default.
export async function resolveParamInt(
  clientId: number,
  key: string,
  hardFallback: number,
): Promise<number> {
  const specific = await getParameterInt(clientId, key, 0);
  if (specific > 0) return specific;
  return getParameterInt(0, key, hardFallback);
}
