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


/**
 * Notas internas que el staff escribió al registrar el pedido (corporativo o al
 * detal). Viven en el mismo JSON que `readableInstructions`; en un pedido de la
 * tienda no existen.
 */
export function staffNotes(raw: string | null): string | null {
  const parsed = parseStaffJson(raw);
  const value = parsed?.['notes'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Contacto que el staff anotó para un pedido corporativo, si lo hay. */
export function corporateContact(
  raw: string | null,
): { name: string; email: string | null; phone: string | null } | null {
  const contact = parseStaffJson(raw)?.['corporate_contact'];
  if (!contact || typeof contact !== 'object') return null;
  const c = contact as Record<string, unknown>;
  if (typeof c['name'] !== 'string') return null;
  return {
    name: c['name'],
    email: typeof c['email'] === 'string' ? c['email'] : null,
    phone: typeof c['phone'] === 'string' ? c['phone'] : null,
  };
}

function parseStaffJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
