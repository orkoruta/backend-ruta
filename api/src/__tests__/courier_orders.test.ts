import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockOrdersFindUnique = vi.fn();
const mockOrdersUpdate = vi.fn();
const mockOrdersFindMany = vi.fn();
const mockOrdersCount = vi.fn();
const mockPaymentsCreate = vi.fn();
const mockAuditEventsCreate = vi.fn();

vi.mock('@orkoruta/db', () => ({
  withTenant: vi.fn(
    (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
      fn({
        orders: {
          findUnique: mockOrdersFindUnique,
          update: mockOrdersUpdate,
          findMany: mockOrdersFindMany,
          count: mockOrdersCount,
        },
        payments: { create: mockPaymentsCreate },
        audit_events: { create: mockAuditEventsCreate },
      }),
  ),
  withTenantReadOnly: vi.fn(
    (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
      fn({
        orders: {
          findUnique: mockOrdersFindUnique,
          findMany: mockOrdersFindMany,
          count: mockOrdersCount,
        },
      }),
  ),
}));

vi.mock('../middleware/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { courierOrdersService } from '../services/orders/courier_orders.service.js';
import { collectionService } from '../services/orders/collection.service.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_ID = 7;
const ORDER_ID = 5001;
const COURIER_ID = 99;
const OTHER_COURIER_ID = 200;

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(ORDER_ID),
    client_id: BigInt(CLIENT_ID),
    courier_user_id: BigInt(COURIER_ID),
    order_status: OrderStatus.COURIER_ASSIGNED,
    payment_status: PaymentStatus.PAYMENT_NOT_STARTED,
    payment_method: 'ONLINE_AT_ORDER',
    refund_status: 'NO_REFUND',
    return_status: null,
    dispute_status: null,
    delivery_type: 'SHIP',
    delivery_carrier_type: null,
    payment_method_submethod: null,
    buyer_type: 'INDIVIDUAL',
    buyer_id: BigInt(42),
    closure_reason: null,
    delivery_address_line: 'Calle 123',
    delivery_address_city: 'Bogotá',
    delivery_address_state: 'Cundinamarca',
    delivery_address_country: 'CO',
    delivery_address_postal_code: null,
    delivery_address_latitude: null,
    delivery_address_longitude: null,
    delivery_instructions: null,
    pickup_point_id: null,
    subtotal: 50000,
    tax: 0,
    shipping_fee: 0,
    discount: 0,
    total: 50000,
    currency: 'COP',
    created_at: new Date(),
    updated_at: new Date(),
    submitted_at: new Date(),
    delivered_at: null,
    closed_at: null,
    order_items: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPaymentsCreate.mockResolvedValue({ id: BigInt(1), amount: 50000, currency: 'COP', status: 'COLLECTED', collected_at: new Date() });
  mockAuditEventsCreate.mockResolvedValue({});
});

// ── getCourierOrderById ───────────────────────────────────────────────────────

describe('getCourierOrderById', () => {
  it('returns order when courier owns it', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder());
    const result = await courierOrdersService.getCourierOrderById(CLIENT_ID, COURIER_ID, ORDER_ID);
    expect(result.id).toBe(ORDER_ID);
    expect(result.order_status).toBe(OrderStatus.COURIER_ASSIGNED);
  });

  it('throws 404 when order not found', async () => {
    mockOrdersFindUnique.mockResolvedValue(null);
    await expect(
      courierOrdersService.getCourierOrderById(CLIENT_ID, COURIER_ID, ORDER_ID),
    ).rejects.toThrow(HttpError);
  });

  it('throws 403 when courier does not own the order', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder({ courier_user_id: BigInt(OTHER_COURIER_ID) }));
    const err = await courierOrdersService
      .getCourierOrderById(CLIENT_ID, COURIER_ID, ORDER_ID)
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(403);
  });
});

// ── startShipping ─────────────────────────────────────────────────────────────

describe('startShipping', () => {
  it('transitions COURIER_ASSIGNED → IN_TRANSIT (via SHIPPED)', async () => {
    const order = makeOrder({ order_status: OrderStatus.COURIER_ASSIGNED });
    mockOrdersFindUnique.mockResolvedValue(order);
    mockOrdersUpdate.mockResolvedValueOnce({ ...order, order_status: OrderStatus.SHIPPED })
      .mockResolvedValueOnce({ ...order, order_status: OrderStatus.IN_TRANSIT, order_items: [] });

    const result = await courierOrdersService.startShipping(CLIENT_ID, COURIER_ID, ORDER_ID);
    expect(result.order_status).toBe(OrderStatus.IN_TRANSIT);
  });

  it('throws 403 when courier does not own the order', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder({ courier_user_id: BigInt(OTHER_COURIER_ID) }));
    const err = await courierOrdersService.startShipping(CLIENT_ID, COURIER_ID, ORDER_ID).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(403);
  });

  it('throws 422 for invalid state transition (already IN_TRANSIT)', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder({ order_status: OrderStatus.IN_TRANSIT }));
    const err = await courierOrdersService.startShipping(CLIENT_ID, COURIER_ID, ORDER_ID).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(422);
  });
});

// ── markDelivered ─────────────────────────────────────────────────────────────

describe('markDelivered', () => {
  it('transitions ARRIVED_AT_CUSTOMER → DELIVERED for non-COD', async () => {
    const order = makeOrder({
      order_status: OrderStatus.ARRIVED_AT_CUSTOMER,
      payment_method: 'ONLINE_AT_ORDER',
      payment_status: PaymentStatus.PAID,
    });
    mockOrdersFindUnique.mockResolvedValue(order);
    mockOrdersUpdate.mockResolvedValue({ ...order, order_status: OrderStatus.DELIVERED, order_items: [] });

    const result = await courierOrdersService.markDelivered(CLIENT_ID, COURIER_ID, ORDER_ID);
    expect(result.order_status).toBe(OrderStatus.DELIVERED);
  });
});

// ── recordCollection ──────────────────────────────────────────────────────────

describe('recordCollection', () => {
  it('throws 422 when order has non-COD payment method', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder({
      order_status: OrderStatus.ARRIVED_AT_CUSTOMER,
      payment_method: 'ONLINE_AT_ORDER',
    }));
    const err = await collectionService
      .recordCollection(CLIENT_ID, COURIER_ID, ORDER_ID, { amount: 50000, currency: 'COP', method: 'CASH' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(422);
  });

  it('throws 403 when courier does not own the order', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder({
      courier_user_id: BigInt(OTHER_COURIER_ID),
      payment_method: 'CASH_ON_DELIVERY',
      order_status: OrderStatus.ARRIVED_AT_CUSTOMER,
    }));
    const err = await collectionService
      .recordCollection(CLIENT_ID, COURIER_ID, ORDER_ID, { amount: 50000, currency: 'COP', method: 'CASH' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(403);
  });

  it('records collection and updates payment_status to PAYMENT_COLLECTED', async () => {
    mockOrdersFindUnique.mockResolvedValue(makeOrder({
      order_status: OrderStatus.ARRIVED_AT_CUSTOMER,
      payment_method: 'CASH_ON_DELIVERY',
      payment_status: PaymentStatus.PENDING_COLLECTION,
    }));
    mockOrdersUpdate.mockResolvedValue({});

    const result = await collectionService.recordCollection(
      CLIENT_ID, COURIER_ID, ORDER_ID,
      { amount: 50000, currency: 'COP', method: 'CASH' },
    );
    expect(result.payment_status).toBe(PaymentStatus.PAYMENT_COLLECTED);
    expect(mockPaymentsCreate).toHaveBeenCalledOnce();
    expect(mockAuditEventsCreate).toHaveBeenCalledOnce();
  });
});

// ── recordFailedAttempt ───────────────────────────────────────────────────────

describe('recordFailedAttempt', () => {
  it('transitions to DELIVERY_ATTEMPTED', async () => {
    const order = makeOrder({ order_status: OrderStatus.OUT_FOR_DELIVERY });
    mockOrdersFindUnique.mockResolvedValue(order);
    mockOrdersUpdate.mockResolvedValue({ ...order, order_status: OrderStatus.DELIVERY_ATTEMPTED, order_items: [] });

    const result = await courierOrdersService.recordFailedAttempt(
      CLIENT_ID, COURIER_ID, ORDER_ID, { reason: 'Nadie en casa' },
    );
    expect(result.order_status).toBe(OrderStatus.DELIVERY_ATTEMPTED);
  });
});
