/**
 * geocoding.service.ts — Geocodificación de direcciones vía Google.
 *
 * Se hace en el backend, y no desde el navegador, porque la Geocoding API es un
 * web service: Google solo permite restringir su clave por IP, así que en el
 * frontend quedaría expuesta y sin acotar.
 *
 * Incluye caché en memoria: el operador corrige la dirección varias veces
 * mientras escribe y cada consulta se cobra.
 */

import { HttpError } from '../lib/http_error.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/** Precisión que reporta Google para el resultado. */
export type GeocodePrecision = 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  formatted_address: string;
  precision: GeocodePrecision;
  /** `true` cuando Google ubicó el predio y no solo la vía o el sector. */
  is_precise: boolean;
}

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results: Array<{
    formatted_address: string;
    geometry: {
      location: { lat: number; lng: number };
      location_type: GeocodePrecision;
    };
  }>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, { value: GeocodeResult | null; expiresAt: number }>();

function cacheKey(address: string, region: string): string {
  return `${region}::${address.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function readCache(key: string): { value: GeocodeResult | null } | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return { value: hit.value };
}

function writeCache(key: string, value: GeocodeResult | null): void {
  // Descarta la entrada más antigua: es un caché de conveniencia, no un índice.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export const geocodingService = {
  /**
   * Resuelve una dirección a coordenadas. Devuelve `null` si Google no la
   * reconoce (ZERO_RESULTS), que es un caso esperado y no un error.
   */
  async geocode(address: string, region = 'co'): Promise<GeocodeResult | null> {
    if (!env.GOOGLE_MAPS_API_KEY) {
      throw new HttpError(
        502,
        'EXTERNAL_SERVICE_ERROR',
        'La geocodificación no está configurada en este entorno',
      );
    }

    const key = cacheKey(address, region);
    const cached = readCache(key);
    if (cached) return cached.value;

    const params = new URLSearchParams({
      address,
      region,
      language: 'es',
      key: env.GOOGLE_MAPS_API_KEY,
    });

    const res = await fetch(`${GOOGLE_GEOCODE_URL}?${params.toString()}`);
    if (!res.ok) {
      logger.error({ status: res.status }, 'geocoding: Google respondió con error HTTP');
      throw new HttpError(502, 'EXTERNAL_SERVICE_ERROR', 'El servicio de geocodificación no respondió');
    }

    const body = (await res.json()) as GoogleGeocodeResponse;

    if (body.status === 'ZERO_RESULTS') {
      writeCache(key, null);
      return null;
    }

    if (body.status !== 'OK') {
      // REQUEST_DENIED / OVER_QUERY_LIMIT son problemas de configuración o cuota:
      // conviene verlos en los logs y no confundirlos con "dirección no existe".
      logger.error(
        { status: body.status, error: body.error_message },
        'geocoding: Google rechazó la consulta',
      );
      throw new HttpError(502, 'EXTERNAL_SERVICE_ERROR', 'El servicio de geocodificación falló');
    }

    const [best] = body.results;
    if (!best) {
      writeCache(key, null);
      return null;
    }

    const precision = best.geometry.location_type;
    const result: GeocodeResult = {
      latitude: Number(best.geometry.location.lat.toFixed(6)),
      longitude: Number(best.geometry.location.lng.toFixed(6)),
      formatted_address: best.formatted_address,
      precision,
      is_precise: precision === 'ROOFTOP' || precision === 'RANGE_INTERPOLATED',
    };

    writeCache(key, result);
    return result;
  },

  /** Solo para tests: vacía el caché entre casos. */
  __clearCache(): void {
    cache.clear();
  },
};
