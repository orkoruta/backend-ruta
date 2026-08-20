import { describe, it, expect } from 'vitest';
import { isGuestBuyer } from '../lib/guest_buyer.js';

/**
 * Compradores invitados en el panel del Cliente.
 *
 * Un invitado pide sin cuenta: su correo es sintético (`guest-<uuid>@guest.ruta`)
 * y no lleva a ninguna bandeja, así que **el teléfono es el único contacto real**.
 * El panel tiene que poder distinguirlos para no ofrecer ese correo como forma
 * de contacto.
 */
describe('isGuestBuyer', () => {
  it('reconoce a un invitado por el prefijo de external_buyer_id', () => {
    expect(isGuestBuyer('guest-248b82fc-097f-415d-a789-91b21db54c90')).toBe(true);
  });

  it('un comprador con cuenta no es invitado', () => {
    // Con cuenta propia el campo va vacío…
    expect(isGuestBuyer(null)).toBe(false);
    expect(isGuestBuyer(undefined)).toBe(false);
    // …o lleva la referencia externa del Cliente, que no usa el prefijo.
    expect(isGuestBuyer('crm-99812')).toBe(false);
  });

  it('no confunde una referencia que solo contenga "guest" sin ser prefijo', () => {
    expect(isGuestBuyer('crm-guest-1')).toBe(false);
    expect(isGuestBuyer('GUEST-1')).toBe(false);
  });
});
