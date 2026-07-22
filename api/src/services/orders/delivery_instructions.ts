/**
 * El pedido corporativo guarda un JSON de contacto en `delivery_instructions`
 * porque `orders` no tiene otro campo de texto libre. El repartidor debe ver la
 * indicación humana ("Casa 19"), nunca el JSON en crudo.
 */
export function readableInstructions(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;

  try {
    const parsed = JSON.parse(trimmed) as { delivery_instructions?: unknown };
    const value = parsed.delivery_instructions;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    // No era JSON: es texto libre de un pedido normal.
    return trimmed;
  }
}

