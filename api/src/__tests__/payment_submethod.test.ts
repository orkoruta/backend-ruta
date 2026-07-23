import { describe, it, expect } from 'vitest';
import { toDbSubmethod, fromDbSubmethod } from '../services/orders/payment_submethod.js';

/**
 * El submétodo `QR` de la app se guarda como `QR_OR_PAYMENT_LINK` en la BD (así
 * lo exige la CHECK constraint de `orders`). Este test fija esa traducción para
 * que no vuelva a colarse un `QR` crudo al INSERT/UPDATE (23514).
 */
describe('payment submethod translation', () => {
  it('traduce QR de la app a QR_OR_PAYMENT_LINK de la BD al escribir', () => {
    expect(toDbSubmethod('QR')).toBe('QR_OR_PAYMENT_LINK');
  });

  it('traduce QR_OR_PAYMENT_LINK de la BD a QR de la app al leer', () => {
    expect(fromDbSubmethod('QR_OR_PAYMENT_LINK')).toBe('QR');
  });

  it('deja pasar los valores que coinciden en ambos lados', () => {
    for (const value of ['DATAFONO', 'BANK_TRANSFER', 'PAYMENT_LINK']) {
      expect(toDbSubmethod(value)).toBe(value);
      expect(fromDbSubmethod(value)).toBe(value);
    }
  });

  it('null/undefined → null en ambos sentidos', () => {
    expect(toDbSubmethod(null)).toBeNull();
    expect(toDbSubmethod(undefined)).toBeNull();
    expect(fromDbSubmethod(null)).toBeNull();
    expect(fromDbSubmethod(undefined)).toBeNull();
  });

  it('ida y vuelta preserva el valor de la app', () => {
    for (const value of ['QR', 'DATAFONO', 'BANK_TRANSFER', 'PAYMENT_LINK']) {
      expect(fromDbSubmethod(toDbSubmethod(value))).toBe(value);
    }
  });
});
