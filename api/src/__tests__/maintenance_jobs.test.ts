import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mocks ─────────────────────────────────────────────────────────────────

const mockDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
const mockFindMany = vi.fn().mockResolvedValue([]);
const mockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock('@orkoruta/db', () => ({
  withTenant: vi.fn((_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({
      clients: { findMany: mockFindMany },
      orders: { findMany: mockFindMany, updateMany: mockUpdateMany },
      idempotency_keys: { deleteMany: mockDeleteMany },
      sessions: { deleteMany: mockDeleteMany },
    })
  ),
  withTenantReadOnly: vi.fn((_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({
      clients: { findMany: mockFindMany },
      orders: { findMany: mockFindMany, updateMany: mockUpdateMany },
      idempotency_keys: { deleteMany: mockDeleteMany },
      sessions: { deleteMany: mockDeleteMany },
    })
  ),
}));

// ── Parameter mock ────────────────────────────────────────────────────────────

const mockGetParameterInt = vi.fn();

vi.mock('../lib/parameter.js', () => ({
  getParameterInt: (...args: unknown[]) => mockGetParameterInt(...args),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────

vi.mock('../middleware/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  processOrderExpiration,
  expireDraftOrders,
  expirePendingConfirmOrders,
  resolveParamInt as resolveOrderParam,
} from '../jobs/order_expiration.job.js';

import { processPaymentTimeout, timeoutPendingPayments } from '../jobs/payment_timeout.job.js';

import { processCleanupIdempotency } from '../jobs/cleanup_idempotency.job.js';

import {
  processCleanupSessions,
  cleanClientSessions,
  daysAgo,
} from '../jobs/cleanup_sessions.job.js';

import {
  processAutoConfirmDelivered,
  autoConfirmDeliveredOrders,
} from '../jobs/auto_confirm_delivered.job.js';

import {
  processPickupExpiration,
  expireReadyForPickupOrders,
} from '../jobs/pickup_expiration.job.js';

import {
  processAtPickupExpiration,
  expireAtPickupPointOrders,
} from '../jobs/at_pickup_expiration.job.js';

// ─────────────────────────────────────────────────────────────────────────────
// daysAgo helper
// ─────────────────────────────────────────────────────────────────────────────

describe('daysAgo', () => {
  it('returns a date N days before now', () => {
    const before = Date.now();
    const result = daysAgo(30);
    const after = Date.now();
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    expect(before - result.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - result.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveParamInt
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveParamInt', () => {
  beforeEach(() => mockGetParameterInt.mockReset());

  it('returns client-specific value when set', async () => {
    mockGetParameterInt.mockResolvedValueOnce(30);
    const result = await resolveOrderParam(5, 'order.draft_expiration_minutes', 1440);
    expect(result).toBe(30);
    expect(mockGetParameterInt).toHaveBeenCalledTimes(1);
  });

  it('falls back to global (client_id=0) when client value is absent', async () => {
    mockGetParameterInt.mockResolvedValueOnce(0).mockResolvedValueOnce(720);
    const result = await resolveOrderParam(5, 'order.draft_expiration_minutes', 1440);
    expect(result).toBe(720);
    expect(mockGetParameterInt).toHaveBeenCalledTimes(2);
    expect(mockGetParameterInt).toHaveBeenLastCalledWith(0, 'order.draft_expiration_minutes', 1440);
  });

  it('returns hardFallback when both client and global are absent', async () => {
    mockGetParameterInt.mockResolvedValueOnce(0).mockResolvedValueOnce(1440);
    const result = await resolveOrderParam(5, 'order.draft_expiration_minutes', 1440);
    expect(result).toBe(1440);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expireDraftOrders
// ─────────────────────────────────────────────────────────────────────────────

describe('expireDraftOrders', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    mockDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('does nothing when no expired DRAFT orders', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await expireDraftOrders(1, 1440);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('transitions each expired DRAFT order to EXPIRED', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(42) }, { id: BigInt(43) }]);
    await expireDraftOrders(1, 1440);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ order_status: 'EXPIRED' }) }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expirePendingConfirmOrders
// ─────────────────────────────────────────────────────────────────────────────

describe('expirePendingConfirmOrders', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('does nothing when no expired PENDING_CONFIRM orders', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await expirePendingConfirmOrders(1, 60);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('transitions each expired PENDING_CONFIRM order to EXPIRED', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(10) }]);
    await expirePendingConfirmOrders(1, 60);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ order_status: 'EXPIRED' }) }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processOrderExpiration
// ─────────────────────────────────────────────────────────────────────────────

describe('processOrderExpiration', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockGetParameterInt.mockReset().mockResolvedValue(1440);
  });

  it('skips processing when no active FULL clients', async () => {
    mockFindMany.mockResolvedValue([]);
    await processOrderExpiration();
    expect(mockGetParameterInt).not.toHaveBeenCalled();
  });

  it('processes each active FULL client', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: BigInt(1) }, { id: BigInt(2) }])
      .mockResolvedValue([]);
    mockGetParameterInt.mockResolvedValue(1440);
    await processOrderExpiration();
    // 1 clients call + 2 clients × 2 order queries = 5 total
    expect(mockFindMany).toHaveBeenCalledTimes(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// timeoutPendingPayments
// ─────────────────────────────────────────────────────────────────────────────

describe('timeoutPendingPayments', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('does nothing when no timed-out payments', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await timeoutPendingPayments(1, 15);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('transitions each timed-out order to EXPIRED', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(99) }]);
    await timeoutPendingPayments(1, 15);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: BigInt(99), client_id: BigInt(1) }),
        data: expect.objectContaining({ order_status: 'EXPIRED' }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processPaymentTimeout
// ─────────────────────────────────────────────────────────────────────────────

describe('processPaymentTimeout', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockGetParameterInt.mockReset().mockResolvedValue(15);
  });

  it('skips when no active FULL clients', async () => {
    mockFindMany.mockResolvedValue([]);
    await processPaymentTimeout();
    expect(mockGetParameterInt).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processCleanupIdempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('processCleanupIdempotency', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('deletes expired idempotency keys for each client', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(0) }, { id: BigInt(1) }]);
    mockDeleteMany.mockResolvedValue({ count: 3 });
    await processCleanupIdempotency();
    expect(mockDeleteMany).toHaveBeenCalledTimes(2);
  });

  it('passes expires_at < now filter', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(1) }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });
    const beforeCall = new Date();
    await processCleanupIdempotency();
    const afterCall = new Date();
    const [deleteCall] = vi.mocked(mockDeleteMany).mock.calls;
    const where = (deleteCall as { where: { expires_at?: { lt: Date } } }[])[0]?.where;
    expect(where?.expires_at?.lt).toBeInstanceOf(Date);
    expect((where?.expires_at?.lt as Date).getTime()).toBeGreaterThanOrEqual(
      beforeCall.getTime() - 100,
    );
    expect((where?.expires_at?.lt as Date).getTime()).toBeLessThanOrEqual(
      afterCall.getTime() + 100,
    );
  });

  it('does nothing when no active clients', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await processCleanupIdempotency();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanClientSessions
// ─────────────────────────────────────────────────────────────────────────────

describe('cleanClientSessions', () => {
  beforeEach(() => mockDeleteMany.mockReset().mockResolvedValue({ count: 0 }));

  it('calls deleteMany with correct OR condition', async () => {
    await cleanClientSessions(1, daysAgo(30), daysAgo(30));
    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
      }),
    );
  });

  it('returns count of deleted sessions', async () => {
    mockDeleteMany.mockResolvedValue({ count: 7 });
    const count = await cleanClientSessions(1, daysAgo(30), daysAgo(30));
    expect(count).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processCleanupSessions
// ─────────────────────────────────────────────────────────────────────────────

describe('processCleanupSessions', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    mockGetParameterInt.mockReset().mockResolvedValue(30);
  });

  it('reads cleanup parameters from global (client_id=0)', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await processCleanupSessions();
    expect(mockGetParameterInt).toHaveBeenCalledWith(0, 'session.cleanup_after_revoked_days', 30);
    expect(mockGetParameterInt).toHaveBeenCalledWith(0, 'session.cleanup_after_expired_days', 30);
  });

  it('deletes sessions for all clients', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(0) }, { id: BigInt(1) }, { id: BigInt(2) }]);
    mockDeleteMany.mockResolvedValue({ count: 1 });
    await processCleanupSessions();
    expect(mockDeleteMany).toHaveBeenCalledTimes(3);
  });

  it('does nothing when no clients', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await processCleanupSessions();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// autoConfirmDeliveredOrders
// ─────────────────────────────────────────────────────────────────────────────

describe('autoConfirmDeliveredOrders', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('does nothing when no DELIVERED orders past threshold', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await autoConfirmDeliveredOrders(1, 72);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('attempts CONFIRMED_BY_SYSTEM update for each expired DELIVERED order', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(7) }]);
    await autoConfirmDeliveredOrders(1, 72);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ order_status: 'CONFIRMED_BY_SYSTEM' }),
      }),
    );
  });

  it('completes full chain CONFIRMED_BY_SYSTEM → COMPLETED_SUCCESSFULLY → CLOSED when update succeeds', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(7) }]);
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // DELIVERED → CONFIRMED_BY_SYSTEM
      .mockResolvedValueOnce({ count: 1 }) // CONFIRMED_BY_SYSTEM → COMPLETED_SUCCESSFULLY
      .mockResolvedValueOnce({ count: 1 }); // COMPLETED_SUCCESSFULLY → CLOSED
    await autoConfirmDeliveredOrders(1, 72);
    expect(mockUpdateMany).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(mockUpdateMany).mock.calls;
    expect((calls[0] as unknown[])[0]).toMatchObject({ data: expect.objectContaining({ order_status: 'CONFIRMED_BY_SYSTEM' }) });
    expect((calls[1] as unknown[])[0]).toMatchObject({ data: expect.objectContaining({ order_status: 'COMPLETED_SUCCESSFULLY' }) });
    expect((calls[2] as unknown[])[0]).toMatchObject({
      data: expect.objectContaining({ order_status: 'CLOSED', closure_reason: 'COMPLETED_SUCCESSFULLY' }),
    });
  });

  it('skips COMPLETED_SUCCESSFULLY and CLOSED if race condition clears the row', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(7) }]);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }); // race: order no longer DELIVERED
    await autoConfirmDeliveredOrders(1, 72);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('processes multiple expired orders independently', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(10) }, { id: BigInt(11) }, { id: BigInt(12) }]);
    await autoConfirmDeliveredOrders(1, 72);
    // count: 0 → each order does 1 attempt (CONFIRMED_BY_SYSTEM) then early-returns
    expect(mockUpdateMany).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processAutoConfirmDelivered
// ─────────────────────────────────────────────────────────────────────────────

describe('processAutoConfirmDelivered', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    mockGetParameterInt.mockReset().mockResolvedValue(72);
  });

  it('skips when no active FULL clients', async () => {
    mockFindMany.mockResolvedValue([]);
    await processAutoConfirmDelivered();
    expect(mockGetParameterInt).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('processes each active FULL client', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: BigInt(1) }, { id: BigInt(2) }])
      .mockResolvedValue([]);
    mockGetParameterInt.mockResolvedValue(72);
    await processAutoConfirmDelivered();
    // 1 clients call + 2 clients × 1 orders query = 3 total findMany calls
    expect(mockFindMany).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expireReadyForPickupOrders
// ─────────────────────────────────────────────────────────────────────────────

describe('expireReadyForPickupOrders', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('does nothing when no READY_FOR_PICKUP orders past threshold', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await expireReadyForPickupOrders(1, 1440);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('attempts EXPIRED update for each stale READY_FOR_PICKUP order', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(55) }, { id: BigInt(56) }]);
    await expireReadyForPickupOrders(1, 1440);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ order_status: 'EXPIRED' }) }),
    );
  });

  it('completes full chain EXPIRED → CLOSED when update succeeds', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(55) }]);
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // READY_FOR_PICKUP → EXPIRED
      .mockResolvedValueOnce({ count: 1 }); // EXPIRED → CLOSED
    await expireReadyForPickupOrders(1, 1440);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mockUpdateMany).mock.calls;
    expect((calls[0] as unknown[])[0]).toMatchObject({ data: expect.objectContaining({ order_status: 'EXPIRED' }) });
    expect((calls[1] as unknown[])[0]).toMatchObject({
      data: expect.objectContaining({ order_status: 'CLOSED', closure_reason: 'PICKUP_EXPIRED' }),
    });
  });

  it('skips CLOSED update if race condition clears the row', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(55) }]);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }); // race: order already moved
    await expireReadyForPickupOrders(1, 1440);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processPickupExpiration
// ─────────────────────────────────────────────────────────────────────────────

describe('processPickupExpiration', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    mockGetParameterInt.mockReset().mockResolvedValue(24); // hours now
  });

  it('skips when no active FULL clients', async () => {
    mockFindMany.mockResolvedValue([]);
    await processPickupExpiration();
    expect(mockGetParameterInt).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('processes each active FULL client', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: BigInt(1) }, { id: BigInt(2) }])
      .mockResolvedValue([]);
    mockGetParameterInt.mockResolvedValue(24);
    await processPickupExpiration();
    // 1 clients call + 2 clients × 1 orders query = 3 total findMany calls
    expect(mockFindMany).toHaveBeenCalledTimes(3);
  });

  it('reads order.pickup_expiration_hours parameter', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: BigInt(1) }])
      .mockResolvedValue([]);
    mockGetParameterInt.mockResolvedValue(48);
    await processPickupExpiration();
    // resolveParamInt calls getParameterInt(clientId, key, 0) first
    expect(mockGetParameterInt).toHaveBeenCalledWith(
      expect.any(Number),
      'order.pickup_expiration_hours',
      expect.any(Number),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expireAtPickupPointOrders
// ─────────────────────────────────────────────────────────────────────────────

describe('expireAtPickupPointOrders', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('does nothing when no AT_PICKUP_POINT orders past threshold', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await expireAtPickupPointOrders(1, 2880);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('transitions AT_PICKUP_POINT → PICKUP_EXPIRED for each stale order', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: BigInt(10), payment_status: 'PENDING_COLLECTION' },
    ]);
    await expireAtPickupPointOrders(1, 2880);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ order_status: 'PICKUP_EXPIRED' }) }),
    );
  });

  it('completes full chain PICKUP_EXPIRED → CLOSED when update succeeds', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(10), payment_status: 'PENDING_COLLECTION' }]);
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // AT_PICKUP_POINT → PICKUP_EXPIRED
      .mockResolvedValueOnce({ count: 1 }); // PICKUP_EXPIRED → CLOSED
    await expireAtPickupPointOrders(1, 2880);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mockUpdateMany).mock.calls;
    expect((calls[0] as unknown[])[0]).toMatchObject({
      data: expect.objectContaining({ order_status: 'PICKUP_EXPIRED' }),
    });
    expect((calls[1] as unknown[])[0]).toMatchObject({
      data: expect.objectContaining({
        order_status: 'CLOSED',
        closure_reason: 'PICKUP_EXPIRED',
        refund_status: 'REFUND_NOT_REQUIRED',
      }),
    });
  });

  it('marks refund_status = REFUND_PENDING when order was PAID', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(20), payment_status: 'PAID' }]);
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    await expireAtPickupPointOrders(1, 2880);
    const calls = vi.mocked(mockUpdateMany).mock.calls;
    expect((calls[1] as unknown[])[0]).toMatchObject({
      data: expect.objectContaining({ refund_status: 'REFUND_PENDING' }),
    });
  });

  it('skips CLOSED update if race condition clears the row', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(30), payment_status: 'PAID' }]);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }); // race: order already moved
    await expireAtPickupPointOrders(1, 2880);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('processes multiple orders independently', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: BigInt(1), payment_status: 'PENDING_COLLECTION' },
      { id: BigInt(2), payment_status: 'PAID' },
    ]);
    await expireAtPickupPointOrders(1, 2880);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processAtPickupExpiration
// ─────────────────────────────────────────────────────────────────────────────

describe('processAtPickupExpiration', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    mockGetParameterInt.mockReset().mockResolvedValue(48);
  });

  it('skips when no active FULL clients', async () => {
    mockFindMany.mockResolvedValue([]);
    await processAtPickupExpiration();
    expect(mockGetParameterInt).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('processes each active FULL client', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: BigInt(1) }, { id: BigInt(2) }])
      .mockResolvedValue([]);
    mockGetParameterInt.mockResolvedValue(48);
    await processAtPickupExpiration();
    // 1 clients call + 2 clients × 1 orders query = 3 total findMany calls
    expect(mockFindMany).toHaveBeenCalledTimes(3);
  });

  it('reads pickup.expiration_hours parameter', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: BigInt(1) }])
      .mockResolvedValue([]);
    mockGetParameterInt.mockResolvedValue(48);
    await processAtPickupExpiration();
    // resolveParamInt calls getParameterInt(clientId, key, 0) first
    expect(mockGetParameterInt).toHaveBeenCalledWith(
      expect.any(Number),
      'pickup.expiration_hours',
      expect.any(Number),
    );
  });
});
