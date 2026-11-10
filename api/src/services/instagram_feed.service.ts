/**
 * Últimas publicaciones de Instagram de un Cliente, para su landing.
 *
 * La landing de Avocado mostraba dos publicaciones escritas a mano en el
 * código: cada vez que publicaban algo nuevo había que editar el repo y
 * redesplegar. Ahora la landing pide aquí las últimas y se renuevan solas.
 *
 * Cómo funciona:
 *  - Usa la Instagram API con inicio de sesión de Instagram
 *    (`graph.instagram.com`). Requiere cuenta profesional (empresa o creador)
 *    y un token de larga duración.
 *  - El token vive en `client_parameters` del propio Cliente, bajo
 *    `integrations.instagram_access_token`. Lo carga el equipo de RUTA con
 *    `infra-ruta/scripts/set_instagram_token.sh`; el panel lo enmascara.
 *  - Los tokens de larga duración caducan a los 60 días. Se renuevan solos aquí
 *    cuando el último refresco tiene más de `TOKEN_REFRESH_AFTER_MS`, así que
 *    mientras la landing reciba visitas el token no llega a caducar.
 *  - Caché en memoria por Cliente (`CACHE_TTL_MS`): la landing se visita mucho
 *    más de lo que el Cliente publica, y Instagram limita las llamadas.
 *  - Si algo falla se devuelve lo último que se tuvo, o una lista vacía: la
 *    landing tiene su respaldo y nunca debe romperse por Instagram.
 */

import { withTenant } from '@orkoruta/db';
import { getParameter } from '../lib/parameter.js';
import { logger } from '../lib/logger.js';

export const INSTAGRAM_TOKEN_PARAM = 'integrations.instagram_access_token';
export const INSTAGRAM_TOKEN_REFRESHED_PARAM = 'integrations.instagram_token_refreshed_at';

const GRAPH_BASE = 'https://graph.instagram.com';
const CACHE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_POSTS = 6;

export interface InstagramPost {
  id: string;
  permalink: string;
  media_type: string;
  timestamp: string;
  thumbnail_url: string | null;
}

interface CacheEntry {
  posts: InstagramPost[];
  fetchedAt: number;
}

const cache = new Map<number, CacheEntry>();

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Instagram respondió ${res.status}: ${message}`);
  }
  return body;
}

async function saveParameter(clientId: number, key: string, value: string, description: string) {
  const now = new Date();
  await withTenant(clientId, 'ADMIN_RUTA', (tx) =>
    tx.client_parameters.upsert({
      where: { client_id_parameter_key: { client_id: BigInt(clientId), parameter_key: key } },
      update: { parameter_value: value, updated_at: now },
      create: {
        client_id: BigInt(clientId),
        parameter_key: key,
        parameter_value: value,
        value_type: 'STRING',
        description,
        is_overrideable_by_client: false,
        created_at: now,
        updated_at: now,
      },
    }),
  );
}

/**
 * Renueva el token si toca. Un fallo aquí no impide usar el token actual, que
 * sigue siendo válido hasta su caducidad.
 */
async function refreshTokenIfDue(clientId: number, token: string): Promise<string> {
  const refreshedAt = await getParameter(clientId, INSTAGRAM_TOKEN_REFRESHED_PARAM);
  const last = refreshedAt ? Date.parse(refreshedAt) : 0;
  if (Number.isFinite(last) && Date.now() - last < TOKEN_REFRESH_AFTER_MS) return token;

  try {
    const body = (await fetchJson(
      `${GRAPH_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
    )) as { access_token?: string };
    const fresh = body.access_token;
    if (!fresh) return token;

    await saveParameter(clientId, INSTAGRAM_TOKEN_PARAM, fresh, 'Token de Instagram (larga duración)');
    await saveParameter(
      clientId,
      INSTAGRAM_TOKEN_REFRESHED_PARAM,
      new Date().toISOString(),
      'Último refresco del token de Instagram',
    );
    logger.info({ clientId }, 'instagram_feed: token renovado');
    return fresh;
  } catch (err) {
    logger.warn({ err, clientId }, 'instagram_feed: no se pudo renovar el token');
    return token;
  }
}

export const instagramFeedService = {
  /**
   * Las `limit` publicaciones más recientes. Lista vacía si el Cliente no tiene
   * Instagram conectado.
   */
  async getLatestPosts(clientId: number, limit = 2): Promise<InstagramPost[]> {
    const take = Math.min(Math.max(limit, 1), MAX_POSTS);
    const cached = cache.get(clientId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.posts.slice(0, take);
    }

    const storedToken = await getParameter(clientId, INSTAGRAM_TOKEN_PARAM);
    if (!storedToken) return [];

    try {
      const token = await refreshTokenIfDue(clientId, storedToken);
      const body = (await fetchJson(
        `${GRAPH_BASE}/me/media?fields=id,permalink,media_type,timestamp,thumbnail_url&limit=${MAX_POSTS}&access_token=${encodeURIComponent(token)}`,
      )) as { data?: Array<Record<string, unknown>> };

      const posts: InstagramPost[] = (body.data ?? [])
        .filter((p) => typeof p['permalink'] === 'string')
        .map((p) => ({
          id: String(p['id']),
          permalink: String(p['permalink']),
          media_type: String(p['media_type'] ?? 'IMAGE'),
          timestamp: String(p['timestamp'] ?? ''),
          thumbnail_url: typeof p['thumbnail_url'] === 'string' ? p['thumbnail_url'] : null,
        }))
        // Más reciente primero, por si la API devuelve fijadas arriba.
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      cache.set(clientId, { posts, fetchedAt: Date.now() });
      return posts.slice(0, take);
    } catch (err) {
      logger.warn({ err, clientId }, 'instagram_feed: no se pudieron leer las publicaciones');
      // Lo último bueno, aunque esté vencido, es mejor que nada.
      if (cached) {
        cache.set(clientId, { posts: cached.posts, fetchedAt: Date.now() });
        return cached.posts.slice(0, take);
      }
      // Sin nada que servir: se recuerda el vacío para no reintentar en cada visita.
      cache.set(clientId, { posts: [], fetchedAt: Date.now() });
      return [];
    }
  },

  /** Solo para tests. */
  clearCache() {
    cache.clear();
  },
};
