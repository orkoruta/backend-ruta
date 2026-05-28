import { withTenant, withTenantReadOnly } from '@orkoruta/db';
import { PaymentStatus } from '@orkoruta/shared';
import type { InitiatePaymentResponse } from '@orkoruta/shared';
import { HttpError } from '../lib/http_error.js';
import { createWompiClientFromProviderConfig } from '../lib/wompi_client.js';
import type { AuthenticatedUser } from '../middleware/auth.js';

function decimalToNumber(val: { toNumber(): number } | number | string): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val);
  return val.toNumber();
}

async function resolveProvider(
  tx: Parameters<Parameters<typeof withTenantReadOnly>[2]>[0],
  clientId: number,
  providerId: bigint | null,
) {
  if (providerId !== null) {
    const provider = await tx.client_payment_providers.findUnique({
      where: { id_client_id: { id: providerId, client_id: BigInt(clientId) } },
      select: { id: true, config: true, webhook_secret: true, status: true, applicable_payment_methods: true },
    });
    if (!provider || provider.status !== 'ACTIVE') {
      throw new HttpError(422, 'PAYMENT_PROVIDER_ERROR', 'Proveedor de pago no encontrado o inactivo');
    }
    return provider;
  }

  const provider = await tx.client_payment_providers.findFirst({
    where: {
      client_id: BigInt(clientId),
      status: 'ACTIVE',
    },
    orderBy: { is_default: 'desc' },
    select: { id: true, config: true, webhook_secret: true, status: true, applicable_payment_methods: true },
  });
  if (!provider) {
    throw new HttpError(422, 'PAYMENT_PROVIDER_ERROR', 'No hay proveedor de pago online configurado para este cliente');
  }
  return provider;
}

export async function initiatePayment(
  orderId: bigint,
  user: AuthenticatedUser,
  redirectUrl?: string,
): Promise<InitiatePaymentResponse> {
  const clientId = user.client_id;

  const order = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
    tx.orders.findUnique({
      where: { id_client_id: { id: orderId, client_id: BigInt(clientId) } },
      select: {
        id: true,
        client_id: true,
        buyer_id: true,
        order_status: true,
        payment_status: true,
        payment_method: true,
        total: true,
        currency: true,
        payment_provider_id: true,
      },
    })
  );

  if (!order) {
    throw new HttpError(404, 'RESOURCE_NOT_FOUND', 'Pedido no encontrado');
  }

  if (order.buyer_id !== BigInt(user.id)) {
    throw new HttpError(403, 'FORBIDDEN', 'Este pedido no pertenece al comprador autenticado');
  }

  if (order.payment_method !== 'ONLINE_AT_ORDER') {
    throw new HttpError(422, 'INVALID_STATE_TRANSITION', 'El método de pago de este pedido no es ONLINE_AT_ORDER');
  }

  const allowedPaymentStatuses: string[] = [
    PaymentStatus.PENDING_ONLINE_PAYMENT,
    PaymentStatus.PAYMENT_FAILED_RETRYABLE,
  ];
  if (!allowedPaymentStatuses.includes(order.payment_status)) {
    throw new HttpError(
      422,
      'INVALID_STATE_TRANSITION',
      `No se puede iniciar el pago desde el estado ${order.payment_status}`,
    );
  }

  const provider = await withTenantReadOnly(clientId, 'BUYER', (tx) =>
    resolveProvider(tx, clientId, order.payment_provider_id)
  );

  const config = (provider.config ?? {}) as { public_key?: string; private_key?: string };
  const wompiClient = createWompiClientFromProviderConfig(config, provider.webhook_secret ?? '');

  const reference = wompiClient.generateReference(orderId);
  const totalAmount = decimalToNumber(order.total);
  const amountInCents = Math.round(totalAmount * 100);

  const checkoutUrl = wompiClient.buildCheckoutUrl({
    reference,
    amountInCents,
    currency: order.currency ?? 'COP',
    redirectUrl,
  });

  await withTenant(clientId, 'BUYER', async (tx) => {
    await tx.payments.create({
      data: {
        client_id: BigInt(clientId),
        order_id: orderId,
        payment_provider_id: provider.id,
        payment_method: 'ONLINE_AT_ORDER',
        amount: totalAmount,
        currency: order.currency ?? 'COP',
        status: 'PENDING',
        external_payment_reference: reference,
      },
    });

    await tx.orders.update({
      where: { id_client_id: { id: orderId, client_id: BigInt(clientId) } },
      data: { payment_status: PaymentStatus.PAYMENT_PROCESSING },
    });
  });

  return {
    order_id: Number(orderId),
    payment_status: PaymentStatus.PAYMENT_PROCESSING,
    wompi_checkout_url: checkoutUrl,
    wompi_reference: reference,
  };
}

export const paymentsService = { initiatePayment };
