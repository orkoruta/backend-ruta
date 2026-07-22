import { getParameterInt } from './parameter.js';

/**
 * Resuelve un entero con la cascada del proyecto: valor propio del Cliente →
 * default global (`client_id = 0`) → valor de código.
 *
 * Vive en su propio módulo, y no junto a `getParameterInt`, para que los tests
 * puedan sustituir el acceso a BD sin reemplazar también esta lógica.
 */
export async function resolveParamInt(
  clientId: number,
  key: string,
  hardFallback: number,
): Promise<number> {
  const specific = await getParameterInt(clientId, key, 0);
  if (specific > 0) return specific;
  return getParameterInt(0, key, hardFallback);
}
