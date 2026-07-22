import { OrderStatus, PaymentStatus } from '@orkoruta/shared';
import { HttpError } from '../../lib/http_error.js';

export type TransitionActor =
  | 'BUYER'
  | 'ADMIN_CLIENT'
  | 'OPERATOR_CLIENT'
  | 'ADMIN_RUTA'
  | 'COURIER'
  | 'SYSTEM'
  | 'API_CLIENT'; // F2.2.BACK-3: Cliente API (máquina-a-máquina)

export interface TransitionContext {
  paymentStatus?: string;
  deliveryType?: string;
  deliveryCarrierType?: string;
  clientType?: string;
  buyerType?: string;
}

interface TransitionRule {
  actors: TransitionActor[];
  /** Recibe el actor para reglas que solo aplican a parte de `actors`. */
  condition?: (ctx: TransitionContext, actor: TransitionActor) => boolean;
}

type TransitionMap = Map<OrderStatus, Map<OrderStatus, TransitionRule>>;

function addRule(
  map: TransitionMap,
  from: OrderStatus,
  to: OrderStatus,
  rule: TransitionRule,
): void {
  if (!map.has(from)) map.set(from, new Map());
  map.get(from)!.set(to, rule);
}

function buildTransitions(): TransitionMap {
  const m: TransitionMap = new Map();

  // ── FLUJO 1 — Creación y decisión de pago ───────────────────────────

  // DRAFT
  // Flujo 6: el pedido corporativo lo registra el Cliente, no el comprador
  // (que no usa la tienda), así que el Cliente también puede confirmarlo.
  // El carrito de un comprador individual sigue siendo solo suyo.
  addRule(m, OrderStatus.DRAFT, OrderStatus.PENDING_CONFIRM, {
    actors: ['BUYER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT'],
    condition: (ctx, actor) => actor === 'BUYER' || ctx.buyerType === 'CORPORATE',
  });
  addRule(m, OrderStatus.DRAFT, OrderStatus.CANCELLED_BY_CUSTOMER, { actors: ['BUYER'] });
  addRule(m, OrderStatus.DRAFT, OrderStatus.EXPIRED, { actors: ['SYSTEM'] });

  // PENDING_CONFIRM
  addRule(m, OrderStatus.PENDING_CONFIRM, OrderStatus.ORDER_SUBMITTED, {
    actors: ['BUYER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT'],
    condition: (ctx, actor) => actor === 'BUYER' || ctx.buyerType === 'CORPORATE',
  });
  addRule(m, OrderStatus.PENDING_CONFIRM, OrderStatus.CANCELLED_BY_CUSTOMER, { actors: ['BUYER'] });
  addRule(m, OrderStatus.PENDING_CONFIRM, OrderStatus.EXPIRED, { actors: ['SYSTEM'] });

  // ORDER_SUBMITTED → validación (por SYSTEM tras pago o inmediatamente para ON_DELIVERY)
  addRule(m, OrderStatus.ORDER_SUBMITTED, OrderStatus.ORDER_VALIDATING, { actors: ['SYSTEM'] });
  addRule(m, OrderStatus.ORDER_SUBMITTED, OrderStatus.EXPIRED, { actors: ['SYSTEM'] });
  addRule(m, OrderStatus.ORDER_SUBMITTED, OrderStatus.CANCELLED_BY_CUSTOMER, {
    actors: ['BUYER'],
    // Solo si el pago no está en curso ni completado
    condition: (ctx) =>
      ctx.paymentStatus === PaymentStatus.PENDING_ONLINE_PAYMENT ||
      ctx.paymentStatus === PaymentStatus.PENDING_COLLECTION,
  });

  // ORDER_VALIDATING (2.BACK-2 usa estas transiciones para sus jobs)
  addRule(m, OrderStatus.ORDER_VALIDATING, OrderStatus.VALIDATION_APPROVED, { actors: ['SYSTEM'] });
  addRule(m, OrderStatus.ORDER_VALIDATING, OrderStatus.MANUAL_REVIEW, { actors: ['SYSTEM'] });
  addRule(m, OrderStatus.ORDER_VALIDATING, OrderStatus.VALIDATION_REJECTED, { actors: ['SYSTEM'] });
  addRule(m, OrderStatus.ORDER_VALIDATING, OrderStatus.CANCELLED_BY_CUSTOMER, { actors: ['BUYER'] });

  // MANUAL_REVIEW (2.BACK-2)
  addRule(m, OrderStatus.MANUAL_REVIEW, OrderStatus.VALIDATION_APPROVED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.MANUAL_REVIEW, OrderStatus.VALIDATION_REJECTED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.MANUAL_REVIEW, OrderStatus.CANCELLED_BY_ADMIN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // VALIDATION_REJECTED → cierre por sistema
  addRule(m, OrderStatus.VALIDATION_REJECTED, OrderStatus.CANCELLED_BY_SYSTEM, { actors: ['SYSTEM'] });

  // VALIDATION_APPROVED → aceptación del vendedor (2.BACK-2)
  addRule(m, OrderStatus.VALIDATION_APPROVED, OrderStatus.SELLER_CONFIRMED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.VALIDATION_APPROVED, OrderStatus.CANCELLED_BY_SELLER, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // SELLER_CONFIRMED → PREPARING (2.BACK-2)
  addRule(m, OrderStatus.SELLER_CONFIRMED, OrderStatus.PREPARING, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // PREPARING — bifurcación logística (2.BACK-2)
  addRule(m, OrderStatus.PREPARING, OrderStatus.AWAITING_COURIER_ASSIGNMENT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
    condition: (ctx) =>
      ctx.deliveryType === 'SHIP' && ctx.deliveryCarrierType === 'OWN_FLEET',
  });
  addRule(m, OrderStatus.PREPARING, OrderStatus.READY_TO_SHIP, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
    condition: (ctx) => ctx.deliveryType === 'SHIP',
  });
  addRule(m, OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
    condition: (ctx) => ctx.deliveryType === 'PICKUP',
  });
  addRule(m, OrderStatus.PREPARING, OrderStatus.CANCELLED_BY_CUSTOMER, { actors: ['BUYER'] });
  addRule(m, OrderStatus.PREPARING, OrderStatus.CANCELLED_BY_ADMIN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
  });

  // ── FLUJO 2 — SHIP ──────────────────────────────────────────────────

  // AWAITING_COURIER_ASSIGNMENT (3.BACK-1)
  addRule(m, OrderStatus.AWAITING_COURIER_ASSIGNMENT, OrderStatus.COURIER_ASSIGNED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
  });
  addRule(m, OrderStatus.AWAITING_COURIER_ASSIGNMENT, OrderStatus.SHIPMENT_HOLD, {
    actors: ['SYSTEM', 'ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
  });

  // COURIER_ASSIGNED (3.BACK-2)
  addRule(m, OrderStatus.COURIER_ASSIGNED, OrderStatus.SHIPPED, { actors: ['COURIER'] });
  addRule(m, OrderStatus.COURIER_ASSIGNED, OrderStatus.AWAITING_COURIER_ASSIGNMENT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'COURIER'],
  });

  // READY_TO_SHIP (3.BACK-2)
  addRule(m, OrderStatus.READY_TO_SHIP, OrderStatus.SHIPPED, {
    actors: ['COURIER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
  });
  addRule(m, OrderStatus.READY_TO_SHIP, OrderStatus.CANCELLED_BY_CUSTOMER, { actors: ['BUYER'] });
  addRule(m, OrderStatus.READY_TO_SHIP, OrderStatus.SHIPMENT_HOLD, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'API_CLIENT'],
  });

  // SHIPMENT_HOLD
  addRule(m, OrderStatus.SHIPMENT_HOLD, OrderStatus.READY_TO_SHIP, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.SHIPMENT_HOLD, OrderStatus.AWAITING_COURIER_ASSIGNMENT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.SHIPMENT_HOLD, OrderStatus.CANCELLED_BY_ADMIN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // SHIPPED (3.BACK-2)
  addRule(m, OrderStatus.SHIPPED, OrderStatus.IN_TRANSIT, { actors: ['COURIER', 'SYSTEM'] });
  addRule(m, OrderStatus.SHIPPED, OrderStatus.CUSTOMER_CANCEL_REQUEST, { actors: ['BUYER'] });

  // IN_TRANSIT (3.BACK-2)
  addRule(m, OrderStatus.IN_TRANSIT, OrderStatus.OUT_FOR_DELIVERY, { actors: ['COURIER'] });
  addRule(m, OrderStatus.IN_TRANSIT, OrderStatus.ON_HOLD, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.IN_TRANSIT, OrderStatus.LOST_IN_TRANSIT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.IN_TRANSIT, OrderStatus.CUSTOMER_CANCEL_REQUEST, { actors: ['BUYER'] });

  // ON_HOLD
  addRule(m, OrderStatus.ON_HOLD, OrderStatus.IN_TRANSIT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.ON_HOLD, OrderStatus.CANCELLED_BY_ADMIN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // OUT_FOR_DELIVERY (3.BACK-2)
  addRule(m, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.ARRIVED_AT_CUSTOMER, { actors: ['COURIER'] });
  addRule(m, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERY_ATTEMPTED, { actors: ['COURIER'] });
  addRule(m, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CUSTOMER_CANCEL_REQUEST, { actors: ['BUYER'] });

  // DELIVERY_ATTEMPTED (3.BACK-2)
  addRule(m, OrderStatus.DELIVERY_ATTEMPTED, OrderStatus.DELIVERY_RESCHEDULED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'COURIER'],
  });
  addRule(m, OrderStatus.DELIVERY_ATTEMPTED, OrderStatus.AT_PICKUP_POINT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.DELIVERY_ATTEMPTED, OrderStatus.RETURN_TO_ORIGIN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // DELIVERY_RESCHEDULED (3.BACK-2)
  addRule(m, OrderStatus.DELIVERY_RESCHEDULED, OrderStatus.OUT_FOR_DELIVERY, {
    actors: ['COURIER', 'SYSTEM'],
  });

  // ARRIVED_AT_CUSTOMER — handoff SHIP (3.BACK-2/3)
  addRule(m, OrderStatus.ARRIVED_AT_CUSTOMER, OrderStatus.DELIVERED, {
    actors: ['COURIER'],
    condition: (ctx) =>
      ctx.paymentStatus === PaymentStatus.PAID ||
      ctx.paymentStatus === PaymentStatus.PAYMENT_COLLECTED,
  });
  addRule(m, OrderStatus.ARRIVED_AT_CUSTOMER, OrderStatus.PAYMENT_COLLECTION_PENDING, {
    actors: ['COURIER'],
    condition: (ctx) => ctx.paymentStatus === PaymentStatus.PENDING_COLLECTION,
  });
  addRule(m, OrderStatus.ARRIVED_AT_CUSTOMER, OrderStatus.CASH_COLLECTION_PENDING, {
    actors: ['COURIER'],
    condition: (ctx) => ctx.paymentStatus === PaymentStatus.PENDING_COLLECTION,
  });

  // PAYMENT_COLLECTION_PENDING — cobro electrónico SHIP + PICKUP (3.BACK-3)
  addRule(m, OrderStatus.PAYMENT_COLLECTION_PENDING, OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, {
    actors: ['COURIER', 'OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.PAYMENT_COLLECTION_PENDING, OrderStatus.RETURN_TO_ORIGIN, {
    actors: ['COURIER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.PAYMENT_COLLECTION_PENDING, OrderStatus.CANCELLED_NO_PAYMENT, {
    actors: ['COURIER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // CASH_COLLECTION_PENDING — cobro efectivo SHIP + PICKUP (3.BACK-3)
  addRule(m, OrderStatus.CASH_COLLECTION_PENDING, OrderStatus.PAYMENT_COLLECTED_CASH, {
    actors: ['COURIER', 'OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.CASH_COLLECTION_PENDING, OrderStatus.CASH_PAYMENT_REJECTED, {
    actors: ['COURIER', 'OPERATOR_CLIENT'],
  });

  // CASH_PAYMENT_REJECTED — SHIP: return, PICKUP: cancelled (3.BACK-3)
  addRule(m, OrderStatus.CASH_PAYMENT_REJECTED, OrderStatus.RETURN_TO_ORIGIN, {
    actors: ['COURIER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.CASH_PAYMENT_REJECTED, OrderStatus.CANCELLED_NO_PAYMENT, {
    actors: ['COURIER', 'ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // PAYMENT_COLLECTED_ELECTRONIC → DELIVERED (SHIP) o PICKED_UP (PICKUP)
  addRule(m, OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, OrderStatus.DELIVERED, {
    actors: ['COURIER'],
  });
  addRule(m, OrderStatus.PAYMENT_COLLECTED_ELECTRONIC, OrderStatus.PICKED_UP, {
    actors: ['COURIER', 'OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });

  // PAYMENT_COLLECTED_CASH → DELIVERED (SHIP) o PICKED_UP (PICKUP)
  addRule(m, OrderStatus.PAYMENT_COLLECTED_CASH, OrderStatus.DELIVERED, { actors: ['COURIER'] });
  addRule(m, OrderStatus.PAYMENT_COLLECTED_CASH, OrderStatus.PICKED_UP, {
    actors: ['COURIER', 'OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });

  // CUSTOMER_CANCEL_REQUEST — cancelación post-despacho (3.BACK-4)
  addRule(m, OrderStatus.CUSTOMER_CANCEL_REQUEST, OrderStatus.CANCEL_REQUEST_APPROVED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.CUSTOMER_CANCEL_REQUEST, OrderStatus.CANCEL_REQUEST_REJECTED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.CUSTOMER_CANCEL_REQUEST, OrderStatus.CANCELLED_BY_ADMIN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // CANCEL_REQUEST_APPROVED → RETURN_TO_ORIGIN
  addRule(m, OrderStatus.CANCEL_REQUEST_APPROVED, OrderStatus.RETURN_TO_ORIGIN, {
    actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });

  // CANCEL_REQUEST_REJECTED → vuelve al estado anterior
  addRule(m, OrderStatus.CANCEL_REQUEST_REJECTED, OrderStatus.IN_TRANSIT, {
    actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.CANCEL_REQUEST_REJECTED, OrderStatus.OUT_FOR_DELIVERY, {
    actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });

  // RETURN_TO_ORIGIN (3.BACK-5)
  addRule(m, OrderStatus.RETURN_TO_ORIGIN, OrderStatus.RETURN_TO_ORIGIN_RECEIVED, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA', 'COURIER'],
  });
  addRule(m, OrderStatus.RETURN_TO_ORIGIN, OrderStatus.LOST_IN_RETURN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // RETURN_TO_ORIGIN_RECEIVED
  addRule(m, OrderStatus.RETURN_TO_ORIGIN_RECEIVED, OrderStatus.CLOSED, {
    actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.RETURN_TO_ORIGIN_RECEIVED, OrderStatus.CANCELLED_NO_PAYMENT, {
    actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.RETURN_TO_ORIGIN_RECEIVED, OrderStatus.CANCELLED_BY_CUSTOMER, {
    actors: ['SYSTEM', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.RETURN_TO_ORIGIN_RECEIVED, OrderStatus.READY_TO_SHIP, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // ── FLUJO 3 — PICKUP ────────────────────────────────────────────────

  // READY_FOR_PICKUP (4.BACK-1)
  addRule(m, OrderStatus.READY_FOR_PICKUP, OrderStatus.AT_PICKUP_POINT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.READY_FOR_PICKUP, OrderStatus.CANCELLED_BY_CUSTOMER, { actors: ['BUYER'] });
  addRule(m, OrderStatus.READY_FOR_PICKUP, OrderStatus.PICKUP_POINT_ISSUE, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.READY_FOR_PICKUP, OrderStatus.DELIVERED, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT'],
  });
  addRule(m, OrderStatus.READY_FOR_PICKUP, OrderStatus.EXPIRED, { actors: ['SYSTEM'] }); // 4.BACK-1

  // AT_PICKUP_POINT (4.BACK-1)
  addRule(m, OrderStatus.AT_PICKUP_POINT, OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.AT_PICKUP_POINT, OrderStatus.PICKUP_EXPIRED, { actors: ['SYSTEM'] });
  addRule(m, OrderStatus.AT_PICKUP_POINT, OrderStatus.CANCELLED_BY_CUSTOMER, { actors: ['BUYER'] });
  addRule(m, OrderStatus.AT_PICKUP_POINT, OrderStatus.PICKUP_POINT_ISSUE, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // PICKUP_POINT_ISSUE
  addRule(m, OrderStatus.PICKUP_POINT_ISSUE, OrderStatus.READY_FOR_PICKUP, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.PICKUP_POINT_ISSUE, OrderStatus.AT_PICKUP_POINT, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.PICKUP_POINT_ISSUE, OrderStatus.CANCELLED_BY_ADMIN, {
    actors: ['ADMIN_CLIENT', 'OPERATOR_CLIENT', 'ADMIN_RUTA'],
  });

  // CUSTOMER_ARRIVED_AT_PICKUP_POINT (4.BACK-1)
  addRule(m, OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, OrderStatus.IDENTITY_VALIDATED, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, OrderStatus.PICKUP_AUTH_FAILED, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, OrderStatus.PICKUP_CANCELLED_BY_CUSTOMER, {
    actors: ['BUYER', 'OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });

  // PICKUP_AUTH_FAILED → retry
  addRule(m, OrderStatus.PICKUP_AUTH_FAILED, OrderStatus.AT_PICKUP_POINT, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });
  addRule(m, OrderStatus.PICKUP_AUTH_FAILED, OrderStatus.CUSTOMER_ARRIVED_AT_PICKUP_POINT, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
  });

  // IDENTITY_VALIDATED — handoff PICKUP (4.BACK-1)
  addRule(m, OrderStatus.IDENTITY_VALIDATED, OrderStatus.PICKED_UP, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
    condition: (ctx) =>
      ctx.paymentStatus === PaymentStatus.PAID ||
      ctx.paymentStatus === PaymentStatus.PAYMENT_COLLECTED,
  });
  addRule(m, OrderStatus.IDENTITY_VALIDATED, OrderStatus.PAYMENT_COLLECTION_PENDING, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
    condition: (ctx) => ctx.paymentStatus === PaymentStatus.PENDING_COLLECTION,
  });
  addRule(m, OrderStatus.IDENTITY_VALIDATED, OrderStatus.CASH_COLLECTION_PENDING, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA'],
    condition: (ctx) => ctx.paymentStatus === PaymentStatus.PENDING_COLLECTION,
  });

  // PICKED_UP → DELIVERED
  addRule(m, OrderStatus.PICKED_UP, OrderStatus.DELIVERED, {
    actors: ['OPERATOR_CLIENT', 'ADMIN_CLIENT', 'ADMIN_RUTA', 'SYSTEM'],
  });

  // ── Finalización exitosa (Bloque 13) ────────────────────────────────

  // DELIVERED
  addRule(m, OrderStatus.DELIVERED, OrderStatus.CONFIRMED_BY_CUSTOMER, { actors: ['BUYER'] });
  addRule(m, OrderStatus.DELIVERED, OrderStatus.CONFIRMED_BY_SYSTEM, { actors: ['SYSTEM'] });
  addRule(m, OrderStatus.DELIVERED, OrderStatus.DELIVERY_DISPUTED, {
    actors: ['BUYER'],
    condition: (ctx) => ctx.clientType === 'FULL',
  });

  // CONFIRMED → COMPLETED_SUCCESSFULLY
  addRule(m, OrderStatus.CONFIRMED_BY_CUSTOMER, OrderStatus.COMPLETED_SUCCESSFULLY, {
    actors: ['SYSTEM'],
  });
  addRule(m, OrderStatus.CONFIRMED_BY_SYSTEM, OrderStatus.COMPLETED_SUCCESSFULLY, {
    actors: ['SYSTEM'],
  });

  // COMPLETED_SUCCESSFULLY → CLOSED
  addRule(m, OrderStatus.COMPLETED_SUCCESSFULLY, OrderStatus.CLOSED, { actors: ['SYSTEM'] });

  // ── Estados de cierre → CLOSED (SYSTEM los cierra a todos) ──────────

  const terminalToClosed: OrderStatus[] = [
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
  for (const status of terminalToClosed) {
    addRule(m, status, OrderStatus.CLOSED, { actors: ['SYSTEM'] });
  }

  return m;
}

const TRANSITIONS = buildTransitions();

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: TransitionActor,
  ctx: TransitionContext = {},
): boolean {
  const toMap = TRANSITIONS.get(from);
  if (!toMap) return false;
  const rule = toMap.get(to);
  if (!rule) return false;
  if (!rule.actors.includes(actor)) return false;
  if (rule.condition && !rule.condition(ctx, actor)) return false;
  return true;
}

export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: TransitionActor,
  ctx: TransitionContext = {},
): void {
  if (!canTransition(from, to, actor, ctx)) {
    throw new HttpError(422, 'INVALID_STATE_TRANSITION', `Transición no permitida: ${from} → ${to}`, {
      from,
      to,
      actor,
    });
  }
}
