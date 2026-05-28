/**
 * state_machine.test.ts — 2.BACK-1
 *
 * Verifica que todas las transiciones permitidas y rechazadas del state machine
 * funcionen correctamente. Tests unitarios sin BD.
 */

import { describe, expect, it } from 'vitest';
import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { canTransition, assertTransition } from '../services/orders/state_machine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function allowed(from: OrderStatus, to: OrderStatus, ...args: Parameters<typeof canTransition> extends [unknown, unknown, ...infer R] ? R : never) {
  return canTransition(from, to, ...args);
}

// ─── FLUJO 1 — Creación y decisión de pago ───────────────────────────────────

describe('Flujo 1 — DRAFT', () => {
  it('DRAFT → PENDING_CONFIRM [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PENDING_CONFIRM, 'BUYER')).toBe(true);
  });

  it('DRAFT → CANCELLED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('DRAFT → EXPIRED [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.EXPIRED, 'SYSTEM')).toBe(true);
  });

  it('DRAFT → PENDING_CONFIRM [ADMIN_CLIENT] ❌ — solo BUYER puede confirmar desde DRAFT', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.PENDING_CONFIRM, 'ADMIN_CLIENT')).toBe(false);
  });

  it('DRAFT → DELIVERED [BUYER] ❌ — transición imposible', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.DELIVERED, 'BUYER')).toBe(false);
  });

  it('DRAFT → EXPIRED [BUYER] ❌ — solo SYSTEM puede expirar', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.EXPIRED, 'BUYER')).toBe(false);
  });
});

describe('Flujo 1 — PENDING_CONFIRM', () => {
  it('PENDING_CONFIRM → ORDER_SUBMITTED [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.PENDING_CONFIRM, OrderStatus.ORDER_SUBMITTED, 'BUYER')).toBe(true);
  });

  it('PENDING_CONFIRM → CANCELLED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.PENDING_CONFIRM, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('PENDING_CONFIRM → EXPIRED [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.PENDING_CONFIRM, OrderStatus.EXPIRED, 'SYSTEM')).toBe(true);
  });

  it('PENDING_CONFIRM → ORDER_SUBMITTED [ADMIN_CLIENT] ❌', () => {
    expect(canTransition(OrderStatus.PENDING_CONFIRM, OrderStatus.ORDER_SUBMITTED, 'ADMIN_CLIENT')).toBe(false);
  });
});

describe('Flujo 1 — ORDER_SUBMITTED', () => {
  it('ORDER_SUBMITTED → ORDER_VALIDATING [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.ORDER_SUBMITTED, OrderStatus.ORDER_VALIDATING, 'SYSTEM')).toBe(true);
  });

  it('ORDER_SUBMITTED → CANCELLED_BY_CUSTOMER [BUYER] con PENDING_ONLINE_PAYMENT ✅', () => {
    expect(
      canTransition(OrderStatus.ORDER_SUBMITTED, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER', {
        paymentStatus: PaymentStatus.PENDING_ONLINE_PAYMENT,
      })
    ).toBe(true);
  });

  it('ORDER_SUBMITTED → CANCELLED_BY_CUSTOMER [BUYER] con PENDING_COLLECTION ✅', () => {
    expect(
      canTransition(OrderStatus.ORDER_SUBMITTED, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER', {
        paymentStatus: PaymentStatus.PENDING_COLLECTION,
      })
    ).toBe(true);
  });

  it('ORDER_SUBMITTED → CANCELLED_BY_CUSTOMER [BUYER] con PAID ❌ — ya pagado', () => {
    expect(
      canTransition(OrderStatus.ORDER_SUBMITTED, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER', {
        paymentStatus: PaymentStatus.PAID,
      })
    ).toBe(false);
  });

  it('ORDER_SUBMITTED → CANCELLED_BY_CUSTOMER [BUYER] con PAYMENT_PROCESSING ❌ — pasarela en proceso', () => {
    expect(
      canTransition(OrderStatus.ORDER_SUBMITTED, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER', {
        paymentStatus: PaymentStatus.PAYMENT_PROCESSING,
      })
    ).toBe(false);
  });

  it('ORDER_SUBMITTED → ORDER_VALIDATING [BUYER] ❌ — solo SYSTEM puede validar', () => {
    expect(canTransition(OrderStatus.ORDER_SUBMITTED, OrderStatus.ORDER_VALIDATING, 'BUYER')).toBe(false);
  });
});

describe('Flujo 1 — Validación operativa', () => {
  it('ORDER_VALIDATING → VALIDATION_APPROVED [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.ORDER_VALIDATING, OrderStatus.VALIDATION_APPROVED, 'SYSTEM')).toBe(true);
  });

  it('ORDER_VALIDATING → MANUAL_REVIEW [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.ORDER_VALIDATING, OrderStatus.MANUAL_REVIEW, 'SYSTEM')).toBe(true);
  });

  it('ORDER_VALIDATING → VALIDATION_REJECTED [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.ORDER_VALIDATING, OrderStatus.VALIDATION_REJECTED, 'SYSTEM')).toBe(true);
  });

  it('ORDER_VALIDATING → CANCELLED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.ORDER_VALIDATING, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('MANUAL_REVIEW → VALIDATION_APPROVED [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.MANUAL_REVIEW, OrderStatus.VALIDATION_APPROVED, 'ADMIN_CLIENT')).toBe(true);
  });

  it('MANUAL_REVIEW → VALIDATION_REJECTED [OPERATOR_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.MANUAL_REVIEW, OrderStatus.VALIDATION_REJECTED, 'OPERATOR_CLIENT')).toBe(true);
  });

  it('MANUAL_REVIEW → VALIDATION_APPROVED [BUYER] ❌', () => {
    expect(canTransition(OrderStatus.MANUAL_REVIEW, OrderStatus.VALIDATION_APPROVED, 'BUYER')).toBe(false);
  });

  it('MANUAL_REVIEW → CANCELLED_BY_ADMIN [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.MANUAL_REVIEW, OrderStatus.CANCELLED_BY_ADMIN, 'ADMIN_CLIENT')).toBe(true);
  });
});

describe('Flujo 1 — Aceptación y preparación', () => {
  it('VALIDATION_APPROVED → SELLER_CONFIRMED [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.VALIDATION_APPROVED, OrderStatus.SELLER_CONFIRMED, 'ADMIN_CLIENT')).toBe(true);
  });

  it('VALIDATION_APPROVED → CANCELLED_BY_SELLER [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.VALIDATION_APPROVED, OrderStatus.CANCELLED_BY_SELLER, 'ADMIN_CLIENT')).toBe(true);
  });

  it('VALIDATION_APPROVED → SELLER_CONFIRMED [BUYER] ❌', () => {
    expect(canTransition(OrderStatus.VALIDATION_APPROVED, OrderStatus.SELLER_CONFIRMED, 'BUYER')).toBe(false);
  });

  it('SELLER_CONFIRMED → PREPARING [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.SELLER_CONFIRMED, OrderStatus.PREPARING, 'ADMIN_CLIENT')).toBe(true);
  });

  it('PREPARING → AWAITING_COURIER_ASSIGNMENT [ADMIN_CLIENT] con SHIP+OWN_FLEET ✅', () => {
    expect(
      canTransition(OrderStatus.PREPARING, OrderStatus.AWAITING_COURIER_ASSIGNMENT, 'ADMIN_CLIENT', {
        deliveryType: 'SHIP',
        deliveryCarrierType: 'OWN_FLEET',
      })
    ).toBe(true);
  });

  it('PREPARING → AWAITING_COURIER_ASSIGNMENT [ADMIN_CLIENT] con SHIP+EXTERNAL_COURIER ❌ — no aplica BLOQUE 6B', () => {
    expect(
      canTransition(OrderStatus.PREPARING, OrderStatus.AWAITING_COURIER_ASSIGNMENT, 'ADMIN_CLIENT', {
        deliveryType: 'SHIP',
        deliveryCarrierType: 'EXTERNAL_COURIER',
      })
    ).toBe(false);
  });

  it('PREPARING → READY_TO_SHIP [ADMIN_CLIENT] con SHIP ✅', () => {
    expect(
      canTransition(OrderStatus.PREPARING, OrderStatus.READY_TO_SHIP, 'ADMIN_CLIENT', {
        deliveryType: 'SHIP',
      })
    ).toBe(true);
  });

  it('PREPARING → READY_FOR_PICKUP [ADMIN_CLIENT] con PICKUP ✅', () => {
    expect(
      canTransition(OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP, 'ADMIN_CLIENT', {
        deliveryType: 'PICKUP',
      })
    ).toBe(true);
  });

  it('PREPARING → READY_FOR_PICKUP [ADMIN_CLIENT] con SHIP ❌ — delivery_type no coincide', () => {
    expect(
      canTransition(OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP, 'ADMIN_CLIENT', {
        deliveryType: 'SHIP',
      })
    ).toBe(false);
  });

  it('PREPARING → CANCELLED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.PREPARING, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('PREPARING → CANCELLED_BY_ADMIN [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.PREPARING, OrderStatus.CANCELLED_BY_ADMIN, 'ADMIN_CLIENT')).toBe(true);
  });
});

// ─── FLUJO 2 — SHIP ──────────────────────────────────────────────────────────

describe('Flujo 2 — SHIP: asignación y despacho', () => {
  it('AWAITING_COURIER_ASSIGNMENT → COURIER_ASSIGNED [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.AWAITING_COURIER_ASSIGNMENT, OrderStatus.COURIER_ASSIGNED, 'ADMIN_CLIENT')).toBe(true);
  });

  it('AWAITING_COURIER_ASSIGNMENT → COURIER_ASSIGNED [BUYER] ❌', () => {
    expect(canTransition(OrderStatus.AWAITING_COURIER_ASSIGNMENT, OrderStatus.COURIER_ASSIGNED, 'BUYER')).toBe(false);
  });

  it('COURIER_ASSIGNED → SHIPPED [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.COURIER_ASSIGNED, OrderStatus.SHIPPED, 'COURIER')).toBe(true);
  });

  it('COURIER_ASSIGNED → SHIPPED [BUYER] ❌', () => {
    expect(canTransition(OrderStatus.COURIER_ASSIGNED, OrderStatus.SHIPPED, 'BUYER')).toBe(false);
  });

  it('COURIER_ASSIGNED → AWAITING_COURIER_ASSIGNMENT [ADMIN_CLIENT] ✅ — reasignación', () => {
    expect(canTransition(OrderStatus.COURIER_ASSIGNED, OrderStatus.AWAITING_COURIER_ASSIGNMENT, 'ADMIN_CLIENT')).toBe(true);
  });

  it('READY_TO_SHIP → SHIPPED [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.READY_TO_SHIP, OrderStatus.SHIPPED, 'COURIER')).toBe(true);
  });

  it('READY_TO_SHIP → CANCELLED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.READY_TO_SHIP, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('SHIPPED → IN_TRANSIT [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.IN_TRANSIT, 'COURIER')).toBe(true);
  });

  it('SHIPPED → CUSTOMER_CANCEL_REQUEST [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.CUSTOMER_CANCEL_REQUEST, 'BUYER')).toBe(true);
  });

  it('SHIPPED → IN_TRANSIT [BUYER] ❌', () => {
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.IN_TRANSIT, 'BUYER')).toBe(false);
  });

  it('IN_TRANSIT → OUT_FOR_DELIVERY [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.IN_TRANSIT, OrderStatus.OUT_FOR_DELIVERY, 'COURIER')).toBe(true);
  });

  it('IN_TRANSIT → CUSTOMER_CANCEL_REQUEST [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.IN_TRANSIT, OrderStatus.CUSTOMER_CANCEL_REQUEST, 'BUYER')).toBe(true);
  });

  it('IN_TRANSIT → LOST_IN_TRANSIT [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.IN_TRANSIT, OrderStatus.LOST_IN_TRANSIT, 'ADMIN_CLIENT')).toBe(true);
  });

  it('IN_TRANSIT → LOST_IN_TRANSIT [COURIER] ❌ — solo admin puede declarar pérdida', () => {
    expect(canTransition(OrderStatus.IN_TRANSIT, OrderStatus.LOST_IN_TRANSIT, 'COURIER')).toBe(false);
  });

  it('OUT_FOR_DELIVERY → ARRIVED_AT_CUSTOMER [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.OUT_FOR_DELIVERY, OrderStatus.ARRIVED_AT_CUSTOMER, 'COURIER')).toBe(true);
  });

  it('OUT_FOR_DELIVERY → DELIVERY_ATTEMPTED [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERY_ATTEMPTED, 'COURIER')).toBe(true);
  });

  it('OUT_FOR_DELIVERY → CUSTOMER_CANCEL_REQUEST [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CUSTOMER_CANCEL_REQUEST, 'BUYER')).toBe(true);
  });
});

describe('Flujo 2 — SHIP: handoff y cobro', () => {
  it('ARRIVED_AT_CUSTOMER → DELIVERED [COURIER] con PAID ✅', () => {
    expect(
      canTransition(OrderStatus.ARRIVED_AT_CUSTOMER, OrderStatus.DELIVERED, 'COURIER', {
        paymentStatus: PaymentStatus.PAID,
      })
    ).toBe(true);
  });

  it('ARRIVED_AT_CUSTOMER → DELIVERED [COURIER] con PENDING_COLLECTION ❌ — debe cobrar primero', () => {
    expect(
      canTransition(OrderStatus.ARRIVED_AT_CUSTOMER, OrderStatus.DELIVERED, 'COURIER', {
        paymentStatus: PaymentStatus.PENDING_COLLECTION,
      })
    ).toBe(false);
  });

  it('ARRIVED_AT_CUSTOMER → PAYMENT_COLLECTION_PENDING [COURIER] con PENDING_COLLECTION ✅', () => {
    expect(
      canTransition(OrderStatus.ARRIVED_AT_CUSTOMER, OrderStatus.PAYMENT_COLLECTION_PENDING, 'COURIER', {
        paymentStatus: PaymentStatus.PENDING_COLLECTION,
      })
    ).toBe(true);
  });

  it('ARRIVED_AT_CUSTOMER → CASH_COLLECTION_PENDING [COURIER] con PENDING_COLLECTION ✅', () => {
    expect(
      canTransition(OrderStatus.ARRIVED_AT_CUSTOMER, OrderStatus.CASH_COLLECTION_PENDING, 'COURIER', {
        paymentStatus: PaymentStatus.PENDING_COLLECTION,
      })
    ).toBe(true);
  });

  it('PAYMENT_COLLECTION_PENDING → PAYMENT_COLLECTED_ELECTRONIC [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.PAYMENT_COLLECTION_PENDING, OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, 'COURIER')).toBe(true);
  });

  it('PAYMENT_COLLECTION_PENDING → RETURN_TO_ORIGIN [COURIER] ✅ — fallo definitivo SHIP', () => {
    expect(canTransition(OrderStatus.PAYMENT_COLLECTION_PENDING, OrderStatus.RETURN_TO_ORIGIN, 'COURIER')).toBe(true);
  });

  it('CASH_COLLECTION_PENDING → PAYMENT_COLLECTED_CASH [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.CASH_COLLECTION_PENDING, OrderStatus.PAYMENT_COLLECTED_CASH, 'COURIER')).toBe(true);
  });

  it('CASH_COLLECTION_PENDING → CASH_PAYMENT_REJECTED [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.CASH_COLLECTION_PENDING, OrderStatus.CASH_PAYMENT_REJECTED, 'COURIER')).toBe(true);
  });

  it('PAYMENT_COLLECTED_ELECTRONIC → DELIVERED [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, OrderStatus.DELIVERED, 'COURIER')).toBe(true);
  });

  it('PAYMENT_COLLECTED_CASH → DELIVERED [COURIER] ✅', () => {
    expect(canTransition(OrderStatus.PAYMENT_COLLECTED_CASH, OrderStatus.DELIVERED, 'COURIER')).toBe(true);
  });
});

describe('Flujo 2 — SHIP: cancelación post-despacho', () => {
  it('CUSTOMER_CANCEL_REQUEST → CANCEL_REQUEST_APPROVED [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.CUSTOMER_CANCEL_REQUEST, OrderStatus.CANCEL_REQUEST_APPROVED, 'ADMIN_CLIENT')).toBe(true);
  });

  it('CUSTOMER_CANCEL_REQUEST → CANCEL_REQUEST_REJECTED [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.CUSTOMER_CANCEL_REQUEST, OrderStatus.CANCEL_REQUEST_REJECTED, 'ADMIN_CLIENT')).toBe(true);
  });

  it('CUSTOMER_CANCEL_REQUEST → CANCEL_REQUEST_APPROVED [BUYER] ❌ — solo admin aprueba', () => {
    expect(canTransition(OrderStatus.CUSTOMER_CANCEL_REQUEST, OrderStatus.CANCEL_REQUEST_APPROVED, 'BUYER')).toBe(false);
  });

  it('CANCEL_REQUEST_APPROVED → RETURN_TO_ORIGIN [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.CANCEL_REQUEST_APPROVED, OrderStatus.RETURN_TO_ORIGIN, 'SYSTEM')).toBe(true);
  });

  it('CANCEL_REQUEST_REJECTED → IN_TRANSIT [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.CANCEL_REQUEST_REJECTED, OrderStatus.IN_TRANSIT, 'SYSTEM')).toBe(true);
  });

  it('CANCEL_REQUEST_REJECTED → OUT_FOR_DELIVERY [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.CANCEL_REQUEST_REJECTED, OrderStatus.OUT_FOR_DELIVERY, 'SYSTEM')).toBe(true);
  });

  it('RETURN_TO_ORIGIN → RETURN_TO_ORIGIN_RECEIVED [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.RETURN_TO_ORIGIN, OrderStatus.RETURN_TO_ORIGIN_RECEIVED, 'ADMIN_CLIENT')).toBe(true);
  });

  it('RETURN_TO_ORIGIN → LOST_IN_RETURN [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.RETURN_TO_ORIGIN, OrderStatus.LOST_IN_RETURN, 'ADMIN_CLIENT')).toBe(true);
  });

  it('RETURN_TO_ORIGIN_RECEIVED → CLOSED [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.RETURN_TO_ORIGIN_RECEIVED, OrderStatus.CLOSED, 'SYSTEM')).toBe(true);
  });

  it('RETURN_TO_ORIGIN_RECEIVED → READY_TO_SHIP [ADMIN_CLIENT] ✅ — reenvío', () => {
    expect(canTransition(OrderStatus.RETURN_TO_ORIGIN_RECEIVED, OrderStatus.READY_TO_SHIP, 'ADMIN_CLIENT')).toBe(true);
  });
});

// ─── FLUJO 3 — PICKUP ────────────────────────────────────────────────────────

describe('Flujo 3 — PICKUP', () => {
  it('READY_FOR_PICKUP → AT_PICKUP_POINT [ADMIN_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.AT_PICKUP_POINT, 'ADMIN_CLIENT')).toBe(true);
  });

  it('READY_FOR_PICKUP → CANCELLED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.READY_FOR_PICKUP, OrderStatus.CANCELLED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('AT_PICKUP_POINT → CUSTOMER_ARRIVED_AT_PICKUP_POINT [OPERATOR_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.AT_PICKUP_POINT, OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, 'OPERATOR_CLIENT')).toBe(true);
  });

  it('AT_PICKUP_POINT → PICKUP_EXPIRED [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.AT_PICKUP_POINT, OrderStatus.PICKUP_EXPIRED, 'SYSTEM')).toBe(true);
  });

  it('AT_PICKUP_POINT → PICKUP_EXPIRED [BUYER] ❌ — solo SYSTEM expira', () => {
    expect(canTransition(OrderStatus.AT_PICKUP_POINT, OrderStatus.PICKUP_EXPIRED, 'BUYER')).toBe(false);
  });

  it('CUSTOMER_ARRIVED_AT_PICKUP_POINT → IDENTITY_VALIDATED [OPERATOR_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, OrderStatus.IDENTITY_VALIDATED, 'OPERATOR_CLIENT')).toBe(true);
  });

  it('CUSTOMER_ARRIVED_AT_PICKUP_POINT → PICKUP_AUTH_FAILED [OPERATOR_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, OrderStatus.PICKUP_AUTH_FAILED, 'OPERATOR_CLIENT')).toBe(true);
  });

  it('CUSTOMER_ARRIVED_AT_PICKUP_POINT → PICKUP_CANCELLED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, OrderStatus.PICKUP_CANCELLED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('PICKUP_AUTH_FAILED → AT_PICKUP_POINT [OPERATOR_CLIENT] ✅ — retry', () => {
    expect(canTransition(OrderStatus.PICKUP_AUTH_FAILED, OrderStatus.AT_PICKUP_POINT, 'OPERATOR_CLIENT')).toBe(true);
  });

  it('IDENTITY_VALIDATED → PICKED_UP [OPERATOR_CLIENT] con PAID ✅', () => {
    expect(
      canTransition(OrderStatus.IDENTITY_VALIDATED, OrderStatus.PICKED_UP, 'OPERATOR_CLIENT', {
        paymentStatus: PaymentStatus.PAID,
      })
    ).toBe(true);
  });

  it('IDENTITY_VALIDATED → PICKED_UP [OPERATOR_CLIENT] con PENDING_COLLECTION ❌ — debe cobrar primero', () => {
    expect(
      canTransition(OrderStatus.IDENTITY_VALIDATED, OrderStatus.PICKED_UP, 'OPERATOR_CLIENT', {
        paymentStatus: PaymentStatus.PENDING_COLLECTION,
      })
    ).toBe(false);
  });

  it('IDENTITY_VALIDATED → PAYMENT_COLLECTION_PENDING [OPERATOR_CLIENT] con PENDING_COLLECTION ✅', () => {
    expect(
      canTransition(OrderStatus.IDENTITY_VALIDATED, OrderStatus.PAYMENT_COLLECTION_PENDING, 'OPERATOR_CLIENT', {
        paymentStatus: PaymentStatus.PENDING_COLLECTION,
      })
    ).toBe(true);
  });

  it('PAYMENT_COLLECTION_PENDING → CANCELLED_NO_PAYMENT [OPERATOR_CLIENT] ✅ — fallo definitivo PICKUP', () => {
    expect(canTransition(OrderStatus.PAYMENT_COLLECTION_PENDING, OrderStatus.CANCELLED_NO_PAYMENT, 'OPERATOR_CLIENT')).toBe(true);
  });

  it('PAYMENT_COLLECTED_ELECTRONIC → PICKED_UP [OPERATOR_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, OrderStatus.PICKED_UP, 'OPERATOR_CLIENT')).toBe(true);
  });

  it('PICKED_UP → DELIVERED [OPERATOR_CLIENT] ✅', () => {
    expect(canTransition(OrderStatus.PICKED_UP, OrderStatus.DELIVERED, 'OPERATOR_CLIENT')).toBe(true);
  });
});

// ─── Finalización exitosa ─────────────────────────────────────────────────────

describe('Finalización exitosa', () => {
  it('DELIVERED → CONFIRMED_BY_CUSTOMER [BUYER] ✅', () => {
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.CONFIRMED_BY_CUSTOMER, 'BUYER')).toBe(true);
  });

  it('DELIVERED → CONFIRMED_BY_SYSTEM [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.CONFIRMED_BY_SYSTEM, 'SYSTEM')).toBe(true);
  });

  it('DELIVERED → CONFIRMED_BY_CUSTOMER [COURIER] ❌', () => {
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.CONFIRMED_BY_CUSTOMER, 'COURIER')).toBe(false);
  });

  it('DELIVERED → DELIVERY_DISPUTED [BUYER] con clientType=FULL ✅', () => {
    expect(
      canTransition(OrderStatus.DELIVERED, OrderStatus.DELIVERY_DISPUTED, 'BUYER', {
        clientType: 'FULL',
      })
    ).toBe(true);
  });

  it('DELIVERED → DELIVERY_DISPUTED [BUYER] con clientType=API ❌ — BLOQUE 15 no aplica a API', () => {
    expect(
      canTransition(OrderStatus.DELIVERED, OrderStatus.DELIVERY_DISPUTED, 'BUYER', {
        clientType: 'API',
      })
    ).toBe(false);
  });

  it('CONFIRMED_BY_CUSTOMER → COMPLETED_SUCCESSFULLY [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.CONFIRMED_BY_CUSTOMER, OrderStatus.COMPLETED_SUCCESSFULLY, 'SYSTEM')).toBe(true);
  });

  it('CONFIRMED_BY_SYSTEM → COMPLETED_SUCCESSFULLY [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.CONFIRMED_BY_SYSTEM, OrderStatus.COMPLETED_SUCCESSFULLY, 'SYSTEM')).toBe(true);
  });

  it('COMPLETED_SUCCESSFULLY → CLOSED [SYSTEM] ✅', () => {
    expect(canTransition(OrderStatus.COMPLETED_SUCCESSFULLY, OrderStatus.CLOSED, 'SYSTEM')).toBe(true);
  });

  it('COMPLETED_SUCCESSFULLY → CLOSED [BUYER] ❌', () => {
    expect(canTransition(OrderStatus.COMPLETED_SUCCESSFULLY, OrderStatus.CLOSED, 'BUYER')).toBe(false);
  });
});

// ─── Estados terminales → CLOSED ─────────────────────────────────────────────

describe('Estados terminales → CLOSED [SYSTEM]', () => {
  const terminalStates: OrderStatus[] = [
    OrderStatus.CANCELLED_BY_CUSTOMER,
    OrderStatus.CANCELLED_BY_SELLER,
    OrderStatus.CANCELLED_BY_SYSTEM,
    OrderStatus.CANCELLED_BY_ADMIN,
    OrderStatus.CANCELLED_NO_PAYMENT,
    OrderStatus.PICKUP_CANCELLED_BY_CUSTOMER,
    OrderStatus.PICKUP_EXPIRED,
    OrderStatus.LOST_IN_TRANSIT,
    OrderStatus.LOST_IN_RETURN,
    OrderStatus.EXPIRED,
  ];

  for (const status of terminalStates) {
    it(`${status} → CLOSED [SYSTEM] ✅`, () => {
      expect(canTransition(status, OrderStatus.CLOSED, 'SYSTEM')).toBe(true);
    });
    it(`${status} → CLOSED [BUYER] ❌`, () => {
      expect(canTransition(status, OrderStatus.CLOSED, 'BUYER')).toBe(false);
    });
  }
});

// ─── assertTransition lanza HttpError ────────────────────────────────────────

describe('assertTransition — lanza error en transición inválida', () => {
  it('lanza HttpError 422 con código INVALID_STATE_TRANSITION', () => {
    expect(() =>
      assertTransition(OrderStatus.DRAFT, OrderStatus.DELIVERED, 'BUYER')
    ).toThrowError('Transición no permitida: DRAFT → DELIVERED');
  });

  it('NO lanza error en transición válida', () => {
    expect(() =>
      assertTransition(OrderStatus.DRAFT, OrderStatus.PENDING_CONFIRM, 'BUYER')
    ).not.toThrow();
  });

  it('lanza error cuando actor no tiene permiso', () => {
    expect(() =>
      assertTransition(OrderStatus.DRAFT, OrderStatus.PENDING_CONFIRM, 'COURIER')
    ).toThrowError('Transición no permitida');
  });

  it('lanza error cuando la condición falla (PAID no puede cancelar)', () => {
    expect(() =>
      assertTransition(
        OrderStatus.ORDER_SUBMITTED,
        OrderStatus.CANCELLED_BY_CUSTOMER,
        'BUYER',
        { paymentStatus: PaymentStatus.PAID }
      )
    ).toThrowError('Transición no permitida');
  });
});
