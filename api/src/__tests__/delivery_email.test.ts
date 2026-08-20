import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  DEFAULT_SUBJECT,
  DEFAULT_BODY,
  PLACEHOLDERS,
} from '../services/notifications/delivery_email.service.js';
import { isGuestBuyer } from '../lib/guest_buyer.js';

/**
 * Aviso de entrega por correo.
 *
 * Se fijan las dos reglas que romperían el correo sin que nadie se entere:
 * la sustitución de marcas y la exclusión de compradores invitados.
 */

describe('renderTemplate', () => {
  const values = {
    comprador: 'Ana',
    pedido: '82',
    total: '$ 38.000',
    negocio: 'Pizzería La Colina',
  };

  it('reemplaza las marcas por sus valores', () => {
    expect(renderTemplate('Hola {{comprador}}, pedido #{{pedido}}', values)).toBe(
      'Hola Ana, pedido #82',
    );
  });

  it('tolera espacios dentro de las llaves', () => {
    expect(renderTemplate('{{ comprador }}', values)).toBe('Ana');
  });

  it('deja intacta una marca desconocida en vez de vaciarla', () => {
    // Vaciarla dejaría el mensaje con huecos sin que el Cliente entienda por
    // qué; verla literal le dice que se equivocó de nombre.
    expect(renderTemplate('Hola {{cliente}}', values)).toBe('Hola {{cliente}}');
  });

  it('reemplaza todas las apariciones, no solo la primera', () => {
    expect(renderTemplate('{{pedido}} y {{pedido}}', values)).toBe('82 y 82');
  });

  it('las plantillas por defecto solo usan marcas declaradas', () => {
    const used = [...`${DEFAULT_SUBJECT} ${DEFAULT_BODY}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
      (m) => m[1]!,
    );
    expect(used.length).toBeGreaterThan(0);
    for (const marca of used) {
      expect(PLACEHOLDERS).toContain(marca as (typeof PLACEHOLDERS)[number]);
    }
  });

  it('las plantillas por defecto quedan legibles al renderizarse', () => {
    const out = renderTemplate(DEFAULT_BODY, values);
    expect(out).toContain('Ana');
    expect(out).toContain('82');
    expect(out).not.toContain('{{');
  });
});

describe('exclusión de compradores invitados', () => {
  it('un invitado no recibe correo: su dirección es sintética', () => {
    // Enviar a `guest-<uuid>@guest.ruta` generaría rebotes y quemaría la
    // reputación del dominio remitente, que es compartido por todos los Clientes.
    expect(isGuestBuyer('guest-248b82fc-097f-415d-a789-91b21db54c90')).toBe(true);
  });

  it('un comprador con cuenta sí lo recibe', () => {
    expect(isGuestBuyer(null)).toBe(false);
  });
});
