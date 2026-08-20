import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El panel del Cliente no debe mostrar carritos (DRAFT): son del comprador y aún
 * no están confirmados. Estos tests capturan el `where` que el servicio real
 * pasa a Prisma para fijar esa regla.
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

const baseQuery = {
  page: 1,
  page_size: 20,
} as Parameters<typeof adminOrdersService.list>[1];

describe('adminOrdersService.list — DRAFT nunca aparece en el panel del Cliente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.findMany = undefined;
    capturedWhere.count = undefined;
  });

  it('sin filtro de estado, excluye DRAFT', async () => {
    await adminOrdersService.list(7, baseQuery);
    const where = capturedWhere.findMany as { order_status: unknown };
    expect(where.order_status).toEqual({ not: 'DRAFT' });
    // El conteo de paginación debe usar el mismo filtro.
    expect(capturedWhere.count).toEqual(capturedWhere.findMany);
  });

  it('con un filtro de estado distinto de DRAFT, filtra por ese estado', async () => {
    await adminOrdersService.list(7, { ...baseQuery, status: 'PREPARING' });
    const where = capturedWhere.findMany as { order_status: unknown };
    expect(where.order_status).toEqual({ equals: 'PREPARING' });
  });

  it('si piden DRAFT explícitamente, devuelve vacío (no lo expone)', async () => {
    await adminOrdersService.list(7, { ...baseQuery, status: 'DRAFT' });
    const where = capturedWhere.findMany as { order_status: unknown };
    expect(where.order_status).toEqual({ in: [] });
  });

  it('oculta los CLOSED por abandono (carrito vencido, pago no completado)', async () => {
    await adminOrdersService.list(7, baseQuery);
    const where = capturedWhere.findMany as {
      NOT: { order_status: string; closure_reason: { in: string[] } };
    };
    // Solo se excluyen los CLOSED cuya razón es de abandono.
    expect(where.NOT.order_status).toBe('CLOSED');
    expect(where.NOT.closure_reason.in).toEqual(
      expect.arrayContaining(['EXPIRED', 'PAYMENT_TIMEOUT', 'CANCELLED_NO_PAYMENT']),
    );
    // No oculta cancelaciones hechas por una persona ni pedidos completados.
    expect(where.NOT.closure_reason.in).not.toContain('CANCELLED_BY_CUSTOMER');
    expect(where.NOT.closure_reason.in).not.toContain('CANCELLED_BY_SELLER');
    expect(where.NOT.closure_reason.in).not.toContain('CANCELLED_BY_ADMIN');
    expect(where.NOT.closure_reason.in).not.toContain('COMPLETED_SUCCESSFULLY');
    // El conteo usa el mismo filtro.
    expect(capturedWhere.count).toEqual(capturedWhere.findMany);
  });
});
