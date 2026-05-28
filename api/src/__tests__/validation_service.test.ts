import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockFindUnique = vi.fn();
const mockCount = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@orkoruta/db', () => ({
  withTenant: vi.fn(
    (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
      fn({
        orders: { findUnique: mockFindUnique, update: mockUpdate },
        products: { count: mockCount },
      }),
  ),
  withTenantReadOnly: vi.fn(
    (_clientId: number, _role: string, fn: (tx: unknown) => unknown) =>
      fn({
        orders: { findUnique: mockFindUnique },
        products: { count: mockCount },
      }),
  ),
}));

// ── Parameter mock ────────────────────────────────────────────────────────────

const mockGetParameterInt = vi.fn().mockResolvedValue(0);

vi.mock('../lib/parameter.js', () => ({
  getParameterInt: (...args: unknown[]) => mockGetParameterInt(...args),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────

vi.mock('../middleware/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { OrderStatus } from '@orkoruta/shared';
import {
  determineValidationOutcome,
  processOrderValidation,
} from '../services/orders/validation.service.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOrder(status: string, productIds: (bigint | null)[] = [1n, 2n]) {
  return {
    order_status: status,
    order_items: productIds.map((id) => ({ product_id: id })),
  };
}

// ── determineValidationOutcome ────────────────────────────────────────────────

describe('determineValidationOutcome', () => {
  const CLIENT_ID = 7;
  const ORDER_ID = 101;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetParameterInt.mockResolvedValue(0);
  });

  it('returns VALIDATION_APPROVED when all products are active', async () => {
    mockFindUnique.mockResolvedValue(makeOrder(OrderStatus.ORDER_VALIDATING));
    mockCount.mockResolvedValue(2); // both products active

    const result = await determineValidationOutcome(ORDER_ID, CLIENT_ID);
    expect(result).toBe('VALIDATION_APPROVED');
  });

  it('returns MANUAL_REVIEW when force_manual_review parameter is set', async () => {
    mockGetParameterInt.mockResolvedValue(1);

    const result = await determineValidationOutcome(ORDER_ID, CLIENT_ID);
    expect(result).toBe('MANUAL_REVIEW');
    expect(mockFindUnique).not.toHaveBeenCalled(); // short-circuits
  });

  it('returns MANUAL_REVIEW when a product is no longer active', async () => {
    mockFindUnique.mockResolvedValue(makeOrder(OrderStatus.ORDER_VALIDATING));
    mockCount.mockResolvedValue(1); // only 1 of 2 products active

    const result = await determineValidationOutcome(ORDER_ID, CLIENT_ID);
    expect(result).toBe('MANUAL_REVIEW');
  });

  it('returns VALIDATION_APPROVED for orders with no product_ids (external items)', async () => {
    mockFindUnique.mockResolvedValue(makeOrder(OrderStatus.ORDER_VALIDATING, [null, null]));

    const result = await determineValidationOutcome(ORDER_ID, CLIENT_ID);
    expect(result).toBe('VALIDATION_APPROVED');
  });

  it('throws 404 when order does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(determineValidationOutcome(ORDER_ID, CLIENT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('throws 422 when order is not in ORDER_VALIDATING', async () => {
    mockFindUnique.mockResolvedValue(makeOrder(OrderStatus.DRAFT));

    await expect(determineValidationOutcome(ORDER_ID, CLIENT_ID)).rejects.toMatchObject({
      statusCode: 422,
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

// ── processOrderValidation ────────────────────────────────────────────────────

describe('processOrderValidation', () => {
  const CLIENT_ID = 7;
  const ORDER_ID = 101;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetParameterInt.mockResolvedValue(0);
  });

  it('transitions ORDER_VALIDATING → VALIDATION_APPROVED when outcome is auto-approve', async () => {
    mockFindUnique
      .mockResolvedValueOnce(makeOrder(OrderStatus.ORDER_VALIDATING)) // determineValidationOutcome read
      .mockResolvedValueOnce({ order_status: OrderStatus.ORDER_VALIDATING }); // withTenant read
    mockCount.mockResolvedValue(2);
    mockUpdate.mockResolvedValue({});

    const outcome = await processOrderValidation(ORDER_ID, CLIENT_ID);

    expect(outcome).toBe('VALIDATION_APPROVED');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ order_status: OrderStatus.VALIDATION_APPROVED }),
      }),
    );
  });

  it('transitions ORDER_VALIDATING → MANUAL_REVIEW when outcome requires review', async () => {
    mockGetParameterInt.mockResolvedValue(1); // force manual review
    mockFindUnique.mockResolvedValue({ order_status: OrderStatus.ORDER_VALIDATING });
    mockUpdate.mockResolvedValue({});

    const outcome = await processOrderValidation(ORDER_ID, CLIENT_ID);

    expect(outcome).toBe('MANUAL_REVIEW');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ order_status: OrderStatus.MANUAL_REVIEW }),
      }),
    );
  });
});
