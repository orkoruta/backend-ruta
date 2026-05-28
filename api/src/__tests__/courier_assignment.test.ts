import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockOrdersFindUnique = vi.fn();
const mockOrdersUpdateMany = vi.fn();
const mockOrdersFindMany = vi.fn();
const mockUsersFindUnique = vi.fn();
const mockUsersFindMany = vi.fn();

vi.mock('@orkoruta/db', () => ({
  withTenant: vi.fn(
    (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
      fn({
        orders: {
          findUnique: mockOrdersFindUnique,
          updateMany: mockOrdersUpdateMany,
          findMany: mockOrdersFindMany,
        },
        users: {
          findUnique: mockUsersFindUnique,
          findMany: mockUsersFindMany,
        },
      }),
  ),
  withTenantReadOnly: vi.fn(
    (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
      fn({
        orders: { findMany: mockOrdersFindMany },
        users: { findMany: mockUsersFindMany },
      }),
  ),
}));

vi.mock('../middleware/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { courierAssignmentService } from '../services/orders/courier_assignment.service.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_ID = 7;
const ORDER_ID = 5001;
const COURIER_USER_ID = 99;

const actingAdmin = { id: 42, client_id: CLIENT_ID, user_type: 'ADMIN_CLIENT', session_id: 1 };

function makeOrder(status: string, version = 1n) {
  return {
    id: BigInt(ORDER_ID),
    client_id: BigInt(CLIENT_ID),
    order_status: status,
    version,
  };
}

function makeCourier(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(COURIER_USER_ID),
    client_id: BigInt(CLIENT_ID),
    user_type: 'COURIER',
    status: 'ACTIVE',
    full_name: 'Ana Repartidora',
    email: 'ana@example.com',
    phone: '+57 300 0000000',
    ...overrides,
  };
}

// ── assignCourier ─────────────────────────────────────────────────────────────

describe('courierAssignmentService.assignCourier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('OK — assigns courier to order in AWAITING_COURIER_ASSIGNMENT', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.AWAITING_COURIER_ASSIGNMENT));
    mockUsersFindUnique.mockResolvedValue(makeCourier());
    mockOrdersUpdateMany.mockResolvedValue({ count: 1 });

    const result = await courierAssignmentService.assignCourier(
      CLIENT_ID,
      ORDER_ID,
      COURIER_USER_ID,
      actingAdmin,
    );

    expect(result.order_status).toBe(OrderStatus.COURIER_ASSIGNED);
    expect(result.courier_user_id).toBe(COURIER_USER_ID);
    expect(mockOrdersUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ version: 1n }),
        data: expect.objectContaining({
          order_status: OrderStatus.COURIER_ASSIGNED,
          courier_user_id: BigInt(COURIER_USER_ID),
        }),
      }),
    );
  });

  it('422 — order in wrong state throws INVALID_STATE_TRANSITION', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.DRAFT));

    await expect(
      courierAssignmentService.assignCourier(CLIENT_ID, ORDER_ID, COURIER_USER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'INVALID_STATE_TRANSITION',
    });

    expect(mockOrdersUpdateMany).not.toHaveBeenCalled();
  });

  it('404 — order not found', async () => {
    mockOrdersFindUnique.mockResolvedValue(null);

    await expect(
      courierAssignmentService.assignCourier(CLIENT_ID, ORDER_ID, COURIER_USER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('422 — courier is INACTIVE', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.AWAITING_COURIER_ASSIGNMENT));
    mockUsersFindUnique.mockResolvedValue(makeCourier({ status: 'INACTIVE' }));

    await expect(
      courierAssignmentService.assignCourier(CLIENT_ID, ORDER_ID, COURIER_USER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });

    expect(mockOrdersUpdateMany).not.toHaveBeenCalled();
  });

  it('403 — courier belongs to a different tenant', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.AWAITING_COURIER_ASSIGNMENT));
    mockUsersFindUnique.mockResolvedValue(makeCourier({ client_id: BigInt(999) }));

    await expect(
      courierAssignmentService.assignCourier(CLIENT_ID, ORDER_ID, COURIER_USER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    expect(mockOrdersUpdateMany).not.toHaveBeenCalled();
  });

  it('422 — user is not a COURIER type', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.AWAITING_COURIER_ASSIGNMENT));
    mockUsersFindUnique.mockResolvedValue(makeCourier({ user_type: 'BUYER' }));

    await expect(
      courierAssignmentService.assignCourier(CLIENT_ID, ORDER_ID, COURIER_USER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('409 — optimistic lock fails when another process updated the order first', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.AWAITING_COURIER_ASSIGNMENT, 5n));
    mockUsersFindUnique.mockResolvedValue(makeCourier());
    mockOrdersUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      courierAssignmentService.assignCourier(CLIENT_ID, ORDER_ID, COURIER_USER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'OPTIMISTIC_LOCK_FAILED',
    });
  });
});

// ── unassignCourier ───────────────────────────────────────────────────────────

describe('courierAssignmentService.unassignCourier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('OK — unassigns courier from COURIER_ASSIGNED order', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.COURIER_ASSIGNED));
    mockOrdersUpdateMany.mockResolvedValue({ count: 1 });

    const result = await courierAssignmentService.unassignCourier(
      CLIENT_ID,
      ORDER_ID,
      actingAdmin,
    );

    expect(result.order_status).toBe(OrderStatus.AWAITING_COURIER_ASSIGNMENT);
    expect(result.courier_user_id).toBeNull();
    expect(mockOrdersUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          order_status: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
          courier_user_id: null,
        }),
      }),
    );
  });

  it('422 — order not in COURIER_ASSIGNED state', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder(OrderStatus.SHIPPED));

    await expect(
      courierAssignmentService.unassignCourier(CLIENT_ID, ORDER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'INVALID_STATE_TRANSITION',
    });

    expect(mockOrdersUpdateMany).not.toHaveBeenCalled();
  });

  it('404 — order not found', async () => {
    mockOrdersFindUnique.mockResolvedValue(null);

    await expect(
      courierAssignmentService.unassignCourier(CLIENT_ID, ORDER_ID, actingAdmin),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

// ── getAvailableCouriers ──────────────────────────────────────────────────────

describe('courierAssignmentService.getAvailableCouriers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only ACTIVE couriers with no active delivery', async () => {
    const rawCouriers = [
      {
        id: BigInt(99),
        client_id: BigInt(CLIENT_ID),
        full_name: 'Ana Repartidora',
        email: 'ana@example.com',
        phone: '+57 300 0000001',
        status: 'ACTIVE',
      },
      {
        id: BigInt(100),
        client_id: BigInt(CLIENT_ID),
        full_name: 'Carlos Mensajero',
        email: 'carlos@example.com',
        phone: '+57 300 0000002',
        status: 'ACTIVE',
      },
    ];

    mockUsersFindMany.mockResolvedValue(rawCouriers);

    const result = await courierAssignmentService.getAvailableCouriers(CLIENT_ID);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(99);
    expect(result[0].full_name).toBe('Ana Repartidora');
    expect(result.every((c) => c.status === 'ACTIVE')).toBe(true);

    expect(mockUsersFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user_type: 'COURIER',
          status: 'ACTIVE',
          orders_orders_courier_user_id_client_idTousers: { none: expect.any(Object) },
        }),
      }),
    );
  });

  it('returns empty list when all couriers are busy', async () => {
    mockUsersFindMany.mockResolvedValue([]);

    const result = await courierAssignmentService.getAvailableCouriers(CLIENT_ID);

    expect(result).toHaveLength(0);
  });
});

// ── getOrdersForMap ───────────────────────────────────────────────────────────

describe('courierAssignmentService.getOrdersForMap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns geolocated orders in AWAITING_COURIER_ASSIGNMENT', async () => {
    const rawOrders = [
      {
        id: BigInt(5001),
        client_id: BigInt(CLIENT_ID),
        order_status: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
        delivery_address_line: 'Cra 7 # 100-50',
        delivery_address_city: 'Bogotá',
        delivery_address_latitude: 4.6951,
        delivery_address_longitude: -74.0427,
        buyer_id: BigInt(10),
        total: 105000,
        currency: 'COP',
        created_at: new Date('2026-01-15T10:00:00Z'),
      },
    ];

    mockOrdersFindMany.mockResolvedValue(rawOrders);

    const result = await courierAssignmentService.getOrdersForMap(CLIENT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(5001);
    expect(result[0].latitude).toBe(4.6951);
    expect(result[0].longitude).toBe(-74.0427);
    expect(result[0].order_status).toBe(OrderStatus.AWAITING_COURIER_ASSIGNMENT);
  });
});
