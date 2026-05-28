/**
 * wompi_server.ts - 2.QA-1
 *
 * Reusable MSW-compatible handlers for Wompi sandbox calls in backend tests.
 * The repo does not currently declare msw, so callers inject MSW's http and
 * HttpResponse objects when they opt into this mock.
 */

const WOMPI_SANDBOX_BASE = 'https://sandbox.wompi.co/v1';

export interface MockWompiTransaction {
  id: string;
  status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
  reference: string;
  amount_in_cents: number;
  currency: string;
}

export const mockWompiTransaction: MockWompiTransaction = {
  id: 'txn_test_123',
  status: 'APPROVED',
  reference: 'RUTA-5001-ABCD1234',
  amount_in_cents: 10500000,
  currency: 'COP',
};

interface MswRequestInfo {
  params: Record<string, string | readonly string[]>;
}

interface MswHttp {
  get: (path: string, resolver: (info: MswRequestInfo) => unknown) => unknown;
}

interface MswHttpResponse {
  json: (body: unknown, init?: { status?: number }) => unknown;
}

export function createWompiHandlers(http: MswHttp, HttpResponse: MswHttpResponse) {
  return [
    http.get(`${WOMPI_SANDBOX_BASE}/transactions/:transactionId`, ({ params }) => {
      const transactionId = String(params.transactionId);

      return HttpResponse.json({
        data: {
          ...mockWompiTransaction,
          id: transactionId,
        },
      });
    }),
  ];
}
