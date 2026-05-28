import crypto from 'node:crypto';

const WOMPI_SANDBOX_BASE = 'https://sandbox.wompi.co/v1';
const WOMPI_PROD_BASE = 'https://production.wompi.co/v1';
const WOMPI_CHECKOUT_URL = 'https://checkout.wompi.co/p/';

export interface WompiConfig {
  publicKey: string;
  privateKey: string;
  webhookSecret: string;
  sandbox: boolean;
}

export interface WompiCheckoutParams {
  reference: string;
  amountInCents: number;
  currency: string;
  redirectUrl?: string;
  customerEmail?: string;
}

export interface WompiTransactionResponse {
  id: string;
  status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
  reference: string;
  amount_in_cents: number;
  currency: string;
}

export class WompiClient {
  private readonly baseUrl: string;

  constructor(private readonly config: WompiConfig) {
    this.baseUrl = config.sandbox ? WOMPI_SANDBOX_BASE : WOMPI_PROD_BASE;
  }

  buildCheckoutUrl(params: WompiCheckoutParams): string {
    const url = new URL(WOMPI_CHECKOUT_URL);
    url.searchParams.set('public-key', this.config.publicKey);
    url.searchParams.set('currency', params.currency);
    url.searchParams.set('amount-in-cents', String(params.amountInCents));
    url.searchParams.set('reference', params.reference);
    if (params.redirectUrl) {
      url.searchParams.set('redirect-url', params.redirectUrl);
    }
    if (params.customerEmail) {
      url.searchParams.set('customer-data:email', params.customerEmail);
    }
    return url.toString();
  }

  generateReference(orderId: bigint): string {
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `RUTA-${orderId}-${suffix}`;
  }

  verifySignature(payload: string, signature: string): boolean {
    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payload)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  }

  async getTransaction(transactionId: string): Promise<WompiTransactionResponse> {
    const url = `${this.baseUrl}/transactions/${transactionId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.privateKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Wompi API error: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as { data: WompiTransactionResponse };
    return body.data;
  }
}

export function createWompiClientFromEnv(overrides?: Partial<WompiConfig>): WompiClient {
  const config: WompiConfig = {
    publicKey: process.env.WOMPI_PUBLIC_KEY ?? '',
    privateKey: process.env.WOMPI_PRIVATE_KEY ?? '',
    webhookSecret: process.env.WOMPI_WEBHOOK_SECRET ?? '',
    sandbox: process.env.NODE_ENV !== 'production',
    ...overrides,
  };
  return new WompiClient(config);
}

export function createWompiClientFromProviderConfig(
  providerConfig: { public_key?: string; private_key?: string },
  webhookSecret: string,
): WompiClient {
  const config: WompiConfig = {
    publicKey: providerConfig.public_key ?? process.env.WOMPI_PUBLIC_KEY ?? '',
    privateKey: providerConfig.private_key ?? process.env.WOMPI_PRIVATE_KEY ?? '',
    webhookSecret,
    sandbox: process.env.NODE_ENV !== 'production',
  };
  return new WompiClient(config);
}
