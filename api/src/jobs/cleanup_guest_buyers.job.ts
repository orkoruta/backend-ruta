import type { PgBoss } from 'pg-boss';
import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { getParameterInt } from '../lib/parameter.js';
import { logger } from '../lib/logger.js';

/**
 * Borra los compradores invitados que no llegaron a pedir nada.
 *
 * Cada vez que alguien agrega al carrito sin sesión se crea un invitado real en
 * `users` (`POST /auth/guest`). Quien se va sin comprar deja una fila huérfana
 * con correo sintético. No tienen retención: si a los N minutos no hay ningún
 * pedido asociado, desaparecen.
 *
 * **Un invitado con pedidos no se toca nunca**, aunque el pedido esté cancelado
 * o cerrado: su `buyer_id` es una FK viva en `orders` y además es el contacto de
 * esa compra. Aquí solo se van los que no dejaron rastro.
 *
 * El borrado va por filas y no en bloque a propósito: si a un invitado le
 * cuelga algo inesperado, se salta esa fila y sigue con las demás en vez de
 * abortar la pasada entera.
 */

export const CLEANUP_GUEST_BUYERS_JOB = 'cleanup_guest_buyers';

/**
 * Cada 5 minutos. El plazo por defecto es de 10, así que un invitado vive como
 * mucho unos 15: suficiente margen para que nadie pierda su carrito a media
 * compra, y lo bastante corto para no acumular basura.
 */
const CRON = '*/5 * * * *';

const ORPHAN_MINUTES_PARAM = 'cleanup.guest_orphan_minutes';
const DEFAULT_ORPHAN_MINUTES = 10;

/** Prefijo que marca a un invitado. Debe coincidir con `lib/guest_buyer.ts`. */
const GUEST_PREFIX = 'guest-';

export async function registerCleanupGuestBuyersJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(CLEANUP_GUEST_BUYERS_JOB);
  await boss.schedule(CLEANUP_GUEST_BUYERS_JOB, CRON);
  await boss.work(CLEANUP_GUEST_BUYERS_JOB, async () => {
    await processCleanupGuestBuyers();
  });
  logger.info({ job: CLEANUP_GUEST_BUYERS_JOB }, 'Job registered');
}

export async function processCleanupGuestBuyers(): Promise<void> {
  const clients = await withTenantReadOnly(0, 'ADMIN_RUTA', (tx) =>
    tx.clients.findMany({
      // El cliente plataforma (id 0) no tiene compradores.
      where: { status: 'ACTIVE', id: { gt: 0n } },
      select: { id: true },
    }),
  );

  for (const client of clients) {
    const clientId = Number(client.id);
    try {
      await cleanupClientGuests(clientId);
    } catch (err) {
      // Un cliente que falle no puede dejar sin limpiar a los demás.
      logger.error({ err, clientId }, 'cleanup_guest_buyers: fallo en el cliente');
    }
  }
}

async function cleanupClientGuests(clientId: number): Promise<void> {
  const minutes = await getParameterInt(clientId, ORPHAN_MINUTES_PARAM, 0)
    || await getParameterInt(0, ORPHAN_MINUTES_PARAM, DEFAULT_ORPHAN_MINUTES);

  const cutoff = new Date(Date.now() - minutes * 60 * 1000);

  const orphans = await withTenantReadOnly(clientId, 'ADMIN_CLIENT', (tx) =>
    tx.users.findMany({
      where: {
        client_id: BigInt(clientId),
        user_type: 'BUYER',
        external_buyer_id: { startsWith: GUEST_PREFIX },
        created_at: { lt: cutoff },
        // Ni un solo pedido, en ningún estado.
        orders_orders_buyer_id_client_idTousers: { none: {} },
      },
      select: { id: true },
      take: 500,
    }),
  );

  if (orphans.length === 0) return;

  let deleted = 0;
  for (const orphan of orphans) {
    try {
      await withTenant(clientId, 'ADMIN_CLIENT', async (tx) => {
        const where = { user_id: BigInt(orphan.id), client_id: BigInt(clientId) };
        // Dependientes primero: las FK apuntan a `users`.
        await tx.sessions.deleteMany({ where });
        await tx.buyer_profiles.deleteMany({ where });
        await tx.users.delete({
          where: { id_client_id: { id: BigInt(orphan.id), client_id: BigInt(clientId) } },
        });
      });
      deleted += 1;
    } catch (err) {
      // Casi siempre será una FK que no anticipamos. Se registra con el id para
      // poder mirarlo, y se sigue: no vale la pena tumbar la pasada por uno.
      logger.warn(
        { err, clientId, userId: String(orphan.id) },
        'cleanup_guest_buyers: no se pudo borrar el invitado, se omite',
      );
    }
  }

  logger.info(
    { clientId, deleted, candidates: orphans.length, olderThanMinutes: minutes },
    'cleanup_guest_buyers: invitados huérfanos eliminados',
  );
}
