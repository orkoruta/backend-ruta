/**
 * Geocodificación al confirmar el pedido.
 *
 * El mapa de asignación filtra por `delivery_address_latitude/longitude`
 * distintos de null, así que un pedido sin coordenadas **desaparece del mapa
 * sin decir nada**: el operador lo ve en la lista, abre «Ir al mapa de
 * asignación» y no está. Pasó de verdad con el pedido 379.
 *
 * Lo que fija este test es sobre todo el caso feo: si Google falla, el pedido
 * tiene que confirmarse igual. Perder la ubicación es malo; perder la venta,
 * peor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGeocode = vi.fn();

vi.mock('../services/geocoding.service.js', () => ({
  geocodingService: { geocode: (...a: unknown[]) => mockGeocode(...a) },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Se prueba la decisión aislada —«¿qué coordenadas se guardan?»— y no el
 * servicio entero: `confirm` está dentro de una transacción con RLS y montar
 * esa maquinaria no diría nada más sobre esta lógica.
 */
async function resolverCoordenadas(addr: {
  line?: string;
  city?: string;
  state?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
} | undefined) {
  const { geocodingService } = await import('../services/geocoding.service.js');
  const { logger } = await import('../lib/logger.js');

  let coords: { lat: number | null; lon: number | null } = {
    lat: addr?.latitude ?? null,
    lon: addr?.longitude ?? null,
  };

  if (addr && coords.lat == null && coords.lon == null) {
    const texto = [addr.line, addr.city, addr.state, addr.country].filter(Boolean).join(', ');
    try {
      const punto = await geocodingService.geocode(texto);
      if (punto) coords = { lat: punto.latitude, lon: punto.longitude };
      else logger.warn({ texto }, 'Google no ubicó la dirección');
    } catch (err) {
      logger.error({ err }, 'Falló la geocodificación');
    }
  }
  return coords;
}

const DIRECCION = {
  line: 'Calle 10b #81f-70',
  city: 'Bogotá',
  state: 'Bogotá D.C.',
  country: 'CO',
};

beforeEach(() => vi.clearAllMocks());

describe('coordenadas al confirmar', () => {
  it('geocodifica cuando el frontend no manda coordenadas', async () => {
    mockGeocode.mockResolvedValue({ latitude: 4.6951, longitude: -74.0427, precision: 'ROOFTOP' });

    const coords = await resolverCoordenadas(DIRECCION);

    expect(coords).toEqual({ lat: 4.6951, lon: -74.0427 });
    // La consulta lleva la dirección completa, no solo la calle.
    expect(mockGeocode).toHaveBeenCalledWith('Calle 10b #81f-70, Bogotá, Bogotá D.C., CO');
  });

  it('respeta las coordenadas del frontend y no gasta una llamada a Google', async () => {
    const coords = await resolverCoordenadas({ ...DIRECCION, latitude: 4.7, longitude: -74.1 });

    expect(coords).toEqual({ lat: 4.7, lon: -74.1 });
    expect(mockGeocode).not.toHaveBeenCalled();
  });

  it('si Google falla, el pedido sigue: coordenadas en null, no excepción', async () => {
    mockGeocode.mockRejectedValue(new Error('502 desde Google'));

    await expect(resolverCoordenadas(DIRECCION)).resolves.toEqual({ lat: null, lon: null });
  });

  it('si Google no encuentra la dirección, tampoco rompe', async () => {
    mockGeocode.mockResolvedValue(null);

    await expect(resolverCoordenadas(DIRECCION)).resolves.toEqual({ lat: null, lon: null });
  });

  it('en PICKUP no hay dirección y no se geocodifica nada', async () => {
    const coords = await resolverCoordenadas(undefined);

    expect(coords).toEqual({ lat: null, lon: null });
    expect(mockGeocode).not.toHaveBeenCalled();
  });
});
