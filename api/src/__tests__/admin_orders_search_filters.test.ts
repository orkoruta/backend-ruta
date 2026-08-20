import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Los tres filtros de la pantalla de pedidos que no filtraban.
 *
 * El buscador y las pestañas de origen mandaban `q` y `order_origin`, que no
 * estaban en el esquema: Zod los descartaba en silencio y la lista salía
 * completa, como si no hubiera coincidencias. Y los selectores de fecha mandan
 * `2026-08-11` contra un `z.string().datetime()`, que exige ISO-8601 completo,
 * así que elegir una fecha devolvía **400 y rompía el listado entero**.
 *
 * Se captura el `where` que llega a Prisma, igual que en
 * `admin_orders_list_filter.test.ts`, porque lo que hay que fijar es la
 * traducción del filtro, no el resultado de la consulta.
 */

const capturedWhere: { findMany?: unknown; count?: unknown } = {};

const mockFindMany = vi.fn(async (args: { where: unknown }) => {
  capturedWhere.findMany = args.where;
  return [];
});
const mockCount = vi.fn(async (args: { where: unknown }) => {
  capturedWhere.count = args.where;
  return 0;
});

vi.mock('@orkoruta/db', () => ({
  withTenantReadOnly: (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({ orders: { findMany: mockFindMany, count: mockCount } }),
  withTenant: (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({ orders: { findMany: mockFindMany, count: mockCount } }),
}));

const { adminOrdersService } = await import('../routes/admin_orders.js');

const baseQuery = { page: 1, page_size: 20 } as Parameters<typeof adminOrdersService.list>[1];

function whereFrom(): Record<string, unknown> {
  return capturedWhere.findMany as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedWhere.findMany = undefined;
  capturedWhere.count = undefined;
});

describe('filtro por fecha: día calendario colombiano', () => {
  it('`date_from` arranca a las 00:00 de Bogotá, no de UTC', async () => {
    await adminOrdersService.list(7, { ...baseQuery, date_from: '2026-08-11' });

    const { created_at } = whereFrom() as { created_at: { gte: Date } };
    // Bogotá es UTC-5: el día empieza a las 05:00Z. Anclarlo a UTC metería en
    // el 11 los pedidos de la tarde-noche del 10.
    expect(created_at.gte.toISOString()).toBe('2026-08-11T05:00:00.000Z');
  });

  it('`date_to` **incluye** el día elegido: corta al inicio del siguiente', async () => {
    await adminOrdersService.list(7, { ...baseQuery, date_to: '2026-08-11' });

    const { created_at } = whereFrom() as { created_at: { lt: Date } };
    expect(created_at.lt.toISOString()).toBe('2026-08-12T05:00:00.000Z');
    // Con un `lte` al inicio del día se perdía todo lo ocurrido ese día, que es
    // justo lo que el operador cree estar incluyendo.
    expect(created_at).not.toHaveProperty('lte');
  });

  it('un rango de un solo día cubre las 24 horas', async () => {
    await adminOrdersService.list(7, {
      ...baseQuery,
      date_from: '2026-08-11',
      date_to: '2026-08-11',
    });

    const { created_at } = whereFrom() as { created_at: { gte: Date; lt: Date } };
    const horas = (created_at.lt.getTime() - created_at.gte.getTime()) / 3_600_000;
    expect(horas).toBe(24);
  });

  it('sigue aceptando un ISO-8601 completo, para no romper a los Clientes API', async () => {
    await adminOrdersService.list(7, { ...baseQuery, date_from: '2026-08-11T13:30:00.000Z' });

    const { created_at } = whereFrom() as { created_at: { gte: Date } };
    expect(created_at.gte.toISOString()).toBe('2026-08-11T13:30:00.000Z');
  });

  it('sin fechas no añade ningún filtro por `created_at`', async () => {
    await adminOrdersService.list(7, baseQuery);
    expect(whereFrom()).not.toHaveProperty('created_at');
  });
});

describe('buscador: «comprador o #pedido»', () => {
  it('busca por nombre y correo del comprador, sin distinguir mayúsculas', async () => {
    await adminOrdersService.list(7, { ...baseQuery, q: 'Marquez' });

    const { OR } = whereFrom() as { OR: Array<Record<string, unknown>> };
    expect(OR[0]).toEqual({
      users_orders_buyer_id_client_idTousers: {
        OR: [
          { full_name: { contains: 'Marquez', mode: 'insensitive' } },
          { email: { contains: 'Marquez', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('un texto de solo dígitos busca además por id de pedido', async () => {
    await adminOrdersService.list(7, { ...baseQuery, q: '42' });

    const { OR } = whereFrom() as { OR: Array<Record<string, unknown>> };
    expect(OR).toContainEqual({ id: 42n });
  });

  it('un texto con letras no busca por id', async () => {
    await adminOrdersService.list(7, { ...baseQuery, q: 'a42' });

    const { OR } = whereFrom() as { OR: Array<Record<string, unknown>> };
    expect(OR).toHaveLength(1);
  });

  it('un número mayor que BIGINT no se manda: abortaría la consulta entera', async () => {
    await adminOrdersService.list(7, { ...baseQuery, q: '99999999999999999999' });

    const { OR } = whereFrom() as { OR: Array<Record<string, unknown>> };
    expect(OR).toHaveLength(1);
  });

  it('sin `q` no añade ningún OR', async () => {
    await adminOrdersService.list(7, baseQuery);
    expect(whereFrom()).not.toHaveProperty('OR');
  });
});

describe('filtro por origen del pedido', () => {
  it('filtra por `order_origin` cuando se pide', async () => {
    await adminOrdersService.list(7, { ...baseQuery, order_origin: 'BUYER_UI' });
    expect(whereFrom().order_origin).toBe('BUYER_UI');
  });

  it('sin origen no lo añade al filtro', async () => {
    await adminOrdersService.list(7, baseQuery);
    expect(whereFrom()).not.toHaveProperty('order_origin');
  });
});

describe('el conteo de paginación usa el mismo filtro que la consulta', () => {
  it('coinciden con todos los filtros activos a la vez', async () => {
    await adminOrdersService.list(7, {
      ...baseQuery,
      q: 'Marquez',
      order_origin: 'BUYER_UI',
      date_from: '2026-08-01',
      date_to: '2026-08-11',
    });

    // Si divergen, la lista muestra una página y el paginador otra cuenta.
    expect(capturedWhere.count).toEqual(capturedWhere.findMany);
  });
});
