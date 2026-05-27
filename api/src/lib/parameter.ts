import { withTenantReadOnly } from '@orkoruta/db';

export async function getParameter(clientId: number, key: string): Promise<string | null> {
  const param = await withTenantReadOnly(clientId, 'ADMIN_RUTA', (tx) =>
    tx.client_parameters.findUnique({
      where: { client_id_parameter_key: { client_id: BigInt(clientId), parameter_key: key } },
      select: { parameter_value: true },
    })
  );
  return param?.parameter_value ?? null;
}

export async function getParameterInt(clientId: number, key: string, fallback: number): Promise<number> {
  const value = await getParameter(clientId, key);
  if (value === null) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}
