/**
 * payments.test.ts - 2.QA-1
 *
 * Exhaustive unit tests for the order state machine used by payment and
 * fulfillment flows. No DB access.
 */

import { describe, expect, it } from 'vitest';
import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import {
  assertTransition,
  canTransition,
  type TransitionActor,
  type TransitionContext,
} from '../services/orders/state_machine.js';

interface AllowedTransition {
  from: OrderStatus;
  to: OrderStatus;
  actors: TransitionActor[];
  ctx?: TransitionContext;
}

interface ConditionalRejection {
  from: OrderStatus;
  to: OrderStatus;
  actor: TransitionActor;
  ctx: TransitionContext;
}

const adminActors: TransitionActor[] = ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'];
const allActors: TransitionActor[] = ['BUYER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'COURIER', 'SYSTEM'];

const allowedTransitions: AllowedTransition[] = [
  { from: OrderStatus.DRAFT, to: OrderStatus.PENDING_CONFIRM, actors: ['BUYER'] },
  { from: OrderStatus.DRAFT, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['BUYER'] },
  { from: OrderStatus.DRAFT, to: OrderStatus.EXPIRED, actors: ['SYSTEM'] },

  { from: OrderStatus.PENDING_CONFIRM, to: OrderStatus.ORDER_SUBMITTED, actors: ['BUYER'] },
  { from: OrderStatus.PENDING_CONFIRM, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['BUYER'] },
  { from: OrderStatus.PENDING_CONFIRM, to: OrderStatus.EXPIRED, actors: ['SYSTEM'] },

  { from: OrderStatus.ORDER_SUBMITTED, to: OrderStatus.ORDER_VALIDATING, actors: ['SYSTEM'] },
  { from: OrderStatus.ORDER_SUBMITTED, to: OrderStatus.EXPIRED, actors: ['SYSTEM'] },
  {
    from: OrderStatus.ORDER_SUBMITTED,
    to: OrderStatus.CANCELLED_BY_CUSTOMER,
    actors: ['BUYER'],
    ctx: { paymentStatus: PaymentStatus.PENDING_ONLINE_PAYMENT },
  },
  {
    from: OrderStatus.ORDER_SUBMITTED,
    to: OrderStatus.CANCELLED_BY_CUSTOMER,
    actors: ['BUYER'],
    ctx: { paymentStatus: PaymentStatus.PENDING_COLLECTION },
  },

  { from: OrderStatus.ORDER_VALIDATING, to: OrderStatus.VALIDATION_APPROVED, actors: ['SYSTEM'] },
  { from: OrderStatus.ORDER_VALIDATING, to: OrderStatus.MANUAL_REVIEW, actors: ['SYSTEM'] },
  { from: OrderStatus.ORDER_VALIDATING, to: OrderStatus.VALIDATION_REJECTED, actors: ['SYSTEM'] },
  { from: OrderStatus.ORDER_VALIDATING, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['BUYER'] },

  { from: OrderStatus.MANUAL_REVIEW, to: OrderStatus.VALIDATION_APPROVED, actors: adminActors },
  { from: OrderStatus.MANUAL_REVIEW, to: OrderStatus.VALIDATION_REJECTED, actors: adminActors },
  { from: OrderStatus.MANUAL_REVIEW, to: OrderStatus.CANCELLED_BY_ADMIN, actors: adminActors },

  { from: OrderStatus.VALIDATION_REJECTED, to: OrderStatus.CANCELLED_BY_SYSTEM, actors: ['SYSTEM'] },
  { from: OrderStatus.VALIDATION_APPROVED, to: OrderStatus.SELLER_CONFIRMED, actors: adminActors },
  { from: OrderStatus.VALIDATION_APPROVED, to: OrderStatus.CANCELLED_BY_SELLER, actors: adminActors },
  { from: OrderStatus.SELLER_CONFIRMED, to: OrderStatus.PREPARING, actors: adminActors },

  {
    from: OrderStatus.PREPARING,
    to: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
    actors: adminActors,
    ctx: { deliveryType: 'SHIP', deliveryCarrierType: 'OWN_FLEET' },
  },
  { from: OrderStatus.PREPARING, to: OrderStatus.READY_TO_SHIP, actors: adminActors, ctx: { deliveryType: 'SHIP' } },
  {
    from: OrderStatus.PREPARING,
    to: OrderStatus.READY_FOR_PICKUP,
    actors: adminActors,
    ctx: { deliveryType: 'PICKUP' },
  },
  { from: OrderStatus.PREPARING, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['BUYER'] },
  { from: OrderStatus.PREPARING, to: OrderStatus.CANCELLED_BY_ADMIN, actors: adminActors },

  { from: OrderStatus.AWAITING_COURIER_ASSIGNMENT, to: OrderStatus.COURIER_ASSIGNED, actors: adminActors },
  {
    from: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
    to: OrderStatus.SHIPMENT_HOLD,
    actors: ['SYSTEM', ...adminActors],
  },
  { from: OrderStatus.COURIER_ASSIGNED, to: OrderStatus.SHIPPED, actors: ['COURIER'] },
  {
    from: OrderStatus.COURIER_ASSIGNED,
    to: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
    actors: [...adminActors, 'COURIER'],
  },
  {
    from: OrderStatus.READY_TO_SHIP,
    to: OrderStatus.SHIPPED,
    actors: ['COURIER', ...adminActors],
  },
  { from: OrderStatus.READY_TO_SHIP, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['BUYER'] },
  { from: OrderStatus.READY_TO_SHIP, to: OrderStatus.SHIPMENT_HOLD, actors: adminActors },
  { from: OrderStatus.SHIPMENT_HOLD, to: OrderStatus.READY_TO_SHIP, actors: adminActors },
  { from: OrderStatus.SHIPMENT_HOLD, to: OrderStatus.AWAITING_COURIER_ASSIGNMENT, actors: adminActors },
  { from: OrderStatus.SHIPMENT_HOLD, to: OrderStatus.CANCELLED_BY_ADMIN, actors: adminActors },
  { from: OrderStatus.SHIPPED, to: OrderStatus.IN_TRANSIT, actors: ['COURIER', 'SYSTEM'] },
  { from: OrderStatus.SHIPPED, to: OrderStatus.CUSTOMER_CANCEL_REQUEST, actors: ['BUYER'] },
  { from: OrderStatus.IN_TRANSIT, to: OrderStatus.OUT_FOR_DELIVERY, actors: ['COURIER'] },
  { from: OrderStatus.IN_TRANSIT, to: OrderStatus.ON_HOLD, actors: adminActors },
  { from: OrderStatus.IN_TRANSIT, to: OrderStatus.LOST_IN_TRANSIT, actors: adminActors },
  { from: OrderStatus.IN_TRANSIT, to: OrderStatus.CUSTOMER_CANCEL_REQUEST, actors: ['BUYER'] },
  { from: OrderStatus.ON_HOLD, to: OrderStatus.IN_TRANSIT, actors: adminActors },
  { from: OrderStatus.ON_HOLD, to: OrderStatus.CANCELLED_BY_ADMIN, actors: adminActors },
  { from: OrderStatus.OUT_FOR_DELIVERY, to: OrderStatus.ARRIVED_AT_CUSTOMER, actors: ['COURIER'] },
  { from: OrderStatus.OUT_FOR_DELIVERY, to: OrderStatus.DELIVERY_ATTEMPTED, actors: ['COURIER'] },
  { from: OrderStatus.OUT_FOR_DELIVERY, to: OrderStatus.CUSTOMER_CANCEL_REQUEST, actors: ['BUYER'] },
  {
    from: OrderStatus.DELIVERY_ATTEMPTED,
    to: OrderStatus.DELIVERY_RESCHEDULED,
    actors: [...adminActors, 'COURIER'],
  },
  { from: OrderStatus.DELIVERY_ATTEMPTED, to: OrderStatus.AT_PICKUP_POINT, actors: adminActors },
  { from: OrderStatus.DELIVERY_ATTEMPTED, to: OrderStatus.RETURN_TO_ORIGIN, actors: adminActors },
  { from: OrderStatus.DELIVERY_RESCHEDULED, to: OrderStatus.OUT_FOR_DELIVERY, actors: ['COURIER', 'SYSTEM'] },

  {
    from: OrderStatus.ARRIVED_AT_CUSTOMER,
    to: OrderStatus.DELIVERED,
    actors: ['COURIER'],
    ctx: { paymentStatus: PaymentStatus.PAID },
  },
  {
    from: OrderStatus.ARRIVED_AT_CUSTOMER,
    to: OrderStatus.DELIVERED,
    actors: ['COURIER'],
    ctx: { paymentStatus: PaymentStatus.PAYMENT_COLLECTED },
  },
  {
    from: OrderStatus.ARRIVED_AT_CUSTOMER,
    to: OrderStatus.PAYMENT_COLLECTION_PENDING,
    actors: ['COURIER'],
    ctx: { paymentStatus: PaymentStatus.PENDING_COLLECTION },
  },
  {
    from: OrderStatus.ARRIVED_AT_CUSTOMER,
    to: OrderStatus.CASH_COLLECTION_PENDING,
    actors: ['COURIER'],
    ctx: { paymentStatus: PaymentStatus.PENDING_COLLECTION },
  },
  {
    from: OrderStatus.PAYMENT_COLLECTION_PENDING,
    to: OrderStatus.PAYMENT_COLLECTED_ELECTRONIC,
    actors: ['COURIER', ...adminActors],
  },
  { from: OrderStatus.PAYMENT_COLLECTION_PENDING, to: OrderStatus.RETURN_TO_ORIGIN, actors: ['COURIER', ...adminActors] },
  { from: OrderStatus.PAYMENT_COLLECTION_PENDING, to: OrderStatus.CANCELLED_NO_PAYMENT, actors: ['COURIER', ...adminActors] },
  { from: OrderStatus.CASH_COLLECTION_PENDING, to: OrderStatus.PAYMENT_COLLECTED_CASH, actors: ['COURIER', ...adminActors] },
  { from: OrderStatus.CASH_COLLECTION_PENDING, to: OrderStatus.CASH_PAYMENT_REJECTED, actors: ['COURIER', 'OPERATOR_CLIENT'] },
  { from: OrderStatus.CASH_PAYMENT_REJECTED, to: OrderStatus.RETURN_TO_ORIGIN, actors: ['COURIER', ...adminActors] },
  { from: OrderStatus.CASH_PAYMENT_REJECTED, to: OrderStatus.CANCELLED_NO_PAYMENT, actors: ['COURIER', ...adminActors] },
  { from: OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, to: OrderStatus.DELIVERED, actors: ['COURIER'] },
  { from: OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, to: OrderStatus.PICKED_UP, actors: ['COURIER', ...adminActors] },
  { from: OrderStatus.PAYMENT_COLLECTED_CASH, to: OrderStatus.DELIVERED, actors: ['COURIER'] },
  { from: OrderStatus.PAYMENT_COLLECTED_CASH, to: OrderStatus.PICKED_UP, actors: ['COURIER', ...adminActors] },
  { from: OrderStatus.CUSTOMER_CANCEL_REQUEST, to: OrderStatus.CANCEL_REQUEST_APPROVED, actors: adminActors },
  { from: OrderStatus.CUSTOMER_CANCEL_REQUEST, to: OrderStatus.CANCEL_REQUEST_REJECTED, actors: adminActors },
  { from: OrderStatus.CUSTOMER_CANCEL_REQUEST, to: OrderStatus.CANCELLED_BY_ADMIN, actors: adminActors },
  { from: OrderStatus.CANCEL_REQUEST_APPROVED, to: OrderStatus.RETURN_TO_ORIGIN, actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  { from: OrderStatus.CANCEL_REQUEST_REJECTED, to: OrderStatus.IN_TRANSIT, actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  { from: OrderStatus.CANCEL_REQUEST_REJECTED, to: OrderStatus.OUT_FOR_DELIVERY, actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  { from: OrderStatus.RETURN_TO_ORIGIN, to: OrderStatus.RETURN_TO_ORIGIN_RECEIVED, actors: [...adminActors, 'COURIER'] },
  { from: OrderStatus.RETURN_TO_ORIGIN, to: OrderStatus.LOST_IN_RETURN, actors: adminActors },
  { from: OrderStatus.RETURN_TO_ORIGIN_RECEIVED, to: OrderStatus.CLOSED, actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  { from: OrderStatus.RETURN_TO_ORIGIN_RECEIVED, to: OrderStatus.CANCELLED_NO_PAYMENT, actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  { from: OrderStatus.RETURN_TO_ORIGIN_RECEIVED, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  { from: OrderStatus.RETURN_TO_ORIGIN_RECEIVED, to: OrderStatus.READY_TO_SHIP, actors: adminActors },

  { from: OrderStatus.READY_FOR_PICKUP, to: OrderStatus.AT_PICKUP_POINT, actors: adminActors },
  { from: OrderStatus.READY_FOR_PICKUP, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['BUYER'] },
  { from: OrderStatus.READY_FOR_PICKUP, to: OrderStatus.PICKUP_POINT_ISSUE, actors: adminActors },
  { from: OrderStatus.AT_PICKUP_POINT, to: OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  { from: OrderStatus.AT_PICKUP_POINT, to: OrderStatus.PICKUP_EXPIRED, actors: ['SYSTEM'] },
  { from: OrderStatus.AT_PICKUP_POINT, to: OrderStatus.CANCELLED_BY_CUSTOMER, actors: ['BUYER'] },
  { from: OrderStatus.AT_PICKUP_POINT, to: OrderStatus.PICKUP_POINT_ISSUE, actors: adminActors },
  { from: OrderStatus.PICKUP_POINT_ISSUE, to: OrderStatus.READY_FOR_PICKUP, actors: adminActors },
  { from: OrderStatus.PICKUP_POINT_ISSUE, to: OrderStatus.AT_PICKUP_POINT, actors: adminActors },
  { from: OrderStatus.PICKUP_POINT_ISSUE, to: OrderStatus.CANCELLED_BY_ADMIN, actors: adminActors },
  {
    from: OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT,
    to: OrderStatus.IDENTITY_VALIDATED,
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  },
  {
    from: OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT,
    to: OrderStatus.PICKUP_AUTH_FAILED,
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  },
  {
    from: OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT,
    to: OrderStatus.PICKUP_CANCELLED_BY_CUSTOMER,
    actors: ['BUYER', 'OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  },
  { from: OrderStatus.PICKUP_AUTH_FAILED, to: OrderStatus.AT_PICKUP_POINT, actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'] },
  {
    from: OrderStatus.PICKUP_AUTH_FAILED,
    to: OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT,
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  },
  {
    from: OrderStatus.IDENTITY_VALIDATED,
    to: OrderStatus.PICKED_UP,
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
    ctx: { paymentStatus: PaymentStatus.PAID },
  },
  {
    from: OrderStatus.IDENTITY_VALIDATED,
    to: OrderStatus.PICKED_UP,
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
    ctx: { paymentStatus: PaymentStatus.PAYMENT_COLLECTED },
  },
  {
    from: OrderStatus.IDENTITY_VALIDATED,
    to: OrderStatus.PAYMENT_COLLECTION_PENDING,
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
    ctx: { paymentStatus: PaymentStatus.PENDING_COLLECTION },
  },
  {
    from: OrderStatus.IDENTITY_VALIDATED,
    to: OrderStatus.CASH_COLLECTION_PENDING,
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
    ctx: { paymentStatus: PaymentStatus.PENDING_COLLECTION },
  },
  { from: OrderStatus.PICKED_UP, to: OrderStatus.DELIVERED, actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA', 'SYSTEM'] },

  { from: OrderStatus.DELIVERED, to: OrderStatus.CONFIRMED_BY_CUSTOMER, actors: ['BUYER'] },
  { from: OrderStatus.DELIVERED, to: OrderStatus.CONFIRMED_BY_SYSTEM, actors: ['SYSTEM'] },
  { from: OrderStatus.DELIVERED, to: OrderStatus.DELIVERY_DISPUTED, actors: ['BUYER'], ctx: { clientType: 'FULL' } },
  { from: OrderStatus.CONFIRMED_BY_CUSTOMER, to: OrderStatus.COMPLETED_SUCCESSFULLY, actors: ['SYSTEM'] },
  { from: OrderStatus.CONFIRMED_BY_SYSTEM, to: OrderStatus.COMPLETED_SUCCESSFULLY, actors: ['SYSTEM'] },
  { from: OrderStatus.COMPLETED_SUCCESSFULLY, to: OrderStatus.CLOSED, actors: ['SYSTEM'] },

  ...[
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
  ].map((from) => ({ from, to: OrderStatus.CLOSED, actors: ['SYSTEM'] })),
];

const conditionalRejections: ConditionalRejection[] = [
  {
    from: OrderStatus.ORDER_SUBMITTED,
    to: OrderStatus.CANCELLED_BY_CUSTOMER,
    actor: 'BUYER',
    ctx: { paymentStatus: PaymentStatus.PAID },
  },
  {
    from: OrderStatus.PREPARING,
    to: OrderStatus.AWAITING_COURIER_ASSIGNMENT,
    actor: 'ADMIN_CLIENT',
    ctx: { deliveryType: 'SHIP', deliveryCarrierType: 'EXTERNAL_COURIER' },
  },
  {
    from: OrderStatus.PREPARING,
    to: OrderStatus.READY_TO_SHIP,
    actor: 'ADMIN_CLIENT',
    ctx: { deliveryType: 'PICKUP' },
  },
  {
    from: OrderStatus.PREPARING,
    to: OrderStatus.READY_FOR_PICKUP,
    actor: 'ADMIN_CLIENT',
    ctx: { deliveryType: 'SHIP' },
  },
  {
    from: OrderStatus.ARRIVED_AT_CUSTOMER,
    to: OrderStatus.DELIVERED,
    actor: 'COURIER',
    ctx: { paymentStatus: PaymentStatus.PENDING_COLLECTION },
  },
  {
    from: OrderStatus.IDENTITY_VALIDATED,
    to: OrderStatus.PICKED_UP,
    actor: 'OPERATOR_CLIENT',
    ctx: { paymentStatus: PaymentStatus.PENDING_COLLECTION },
  },
  {
    from: OrderStatus.DELIVERED,
    to: OrderStatus.DELIVERY_DISPUTED,
    actor: 'BUYER',
    ctx: { clientType: 'API' },
  },
];

describe('Order state machine - allowed transitions', () => {
  for (const transition of allowedTransitions) {
    for (const actor of transition.actors) {
      it(`allows ${transition.from} -> ${transition.to} for ${actor}`, () => {
        expect(canTransition(transition.from, transition.to, actor, transition.ctx)).toBe(true);
        expect(() => assertTransition(transition.from, transition.to, actor, transition.ctx)).not.toThrow();
      });
    }
  }
});

describe('Order state machine - rejected transitions', () => {
  const allowedPairs = new Set(allowedTransitions.map(({ from, to }) => `${from}:${to}`));
  const statuses = Object.values(OrderStatus);

  for (const transition of allowedTransitions) {
    const rejectedActors = allActors.filter((actor) => !transition.actors.includes(actor));

    for (const actor of rejectedActors) {
      it(`rejects ${transition.from} -> ${transition.to} for unauthorized actor ${actor}`, () => {
        expect(canTransition(transition.from, transition.to, actor, transition.ctx)).toBe(false);
        expect(() => assertTransition(transition.from, transition.to, actor, transition.ctx)).toThrowError(
          'Transición no permitida',
        );
      });
    }
  }

  for (const rejection of conditionalRejections) {
    it(`rejects ${rejection.from} -> ${rejection.to} when context does not satisfy the rule`, () => {
      expect(canTransition(rejection.from, rejection.to, rejection.actor, rejection.ctx)).toBe(false);
      expect(() =>
        assertTransition(rejection.from, rejection.to, rejection.actor, rejection.ctx),
      ).toThrowError('Transición no permitida');
    });
  }

  for (const from of statuses) {
    for (const to of statuses) {
      if (allowedPairs.has(`${from}:${to}`)) continue;

      it(`rejects undefined transition ${from} -> ${to} for every actor`, () => {
        for (const actor of allActors) {
          expect(canTransition(from, to, actor)).toBe(false);
        }
      });
    }
  }
});
