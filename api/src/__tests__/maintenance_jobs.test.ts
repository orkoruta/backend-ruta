import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mocks ─────────────────────────────────────────────────────────────────

const mockDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
const mockFindMany = vi.fn().mockResolvedValue([]);

vi.mock('@orkoruta/db', () => ({
  withTenant: vi.fn((_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({
      clients: { findMany: mockFindMany },
      orders: { findMany: mockFindMany },
      idempotency_keys: { deleteMany: mockDeleteMany },
      sessions: { deleteMany: mockDeleteMany },
    })
  ),
  withTenantReadOnly: vi.fn((_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
    fn({
      clients: { findMany: mockFindMany },
      orders: { findMany: mockFindMany },
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
    mockDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('does nothing when no expired DRAFT orders', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await expireDraftOrders(1, 1440);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('logs warn for each expired DRAFT order (state_machine TODO)', async () => {
    const { logger } = await import('../middleware/logger.js');
    vi.mocked(logger.warn).mockClear();
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(42) }, { id: BigInt(43) }]);
    await expireDraftOrders(1, 1440);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expirePendingConfirmOrders
// ─────────────────────────────────────────────────────────────────────────────

describe('expirePendingConfirmOrders', () => {
  beforeEach(() => mockFindMany.mockReset());

  it('does nothing when no expired PENDING_CONFIRM orders', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await expirePendingConfirmOrders(1, 60);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('logs warn for each expired PENDING_CONFIRM order', async () => {
    const { logger } = await import('../middleware/logger.js');
    vi.mocked(logger.warn).mockClear();
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(10) }]);
    await expirePendingConfirmOrders(1, 60);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
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
  beforeEach(() => mockFindMany.mockReset());

  it('does nothing when no timed-out payments', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await timeoutPendingPayments(1, 15);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('logs warn for each timed-out payment (state_machine TODO)', async () => {
    const { logger } = await import('../middleware/logger.js');
    vi.mocked(logger.warn).mockClear();
    mockFindMany.mockResolvedValueOnce([{ id: BigInt(99) }]);
    await timeoutPendingPayments(1, 15);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: '99', clientId: 1 }),
      expect.stringContaining('2.BACK-1'),
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
