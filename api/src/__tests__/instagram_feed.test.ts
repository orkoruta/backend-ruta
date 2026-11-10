import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Últimas publicaciones de Instagram para la landing de un Cliente.
 *
 * Fija: sin token no se llama a Instagram; se devuelven las más recientes
 * primero; la caché evita una llamada por visita; el token se renueva cuando
 * toca; y si Instagram falla se sirve lo último bueno en vez de romper.
 */

const params = new Map<string, string>();
const upserts: Array<{ key: string; value: string }> = [];

vi.mock('../lib/parameter.js', () => ({
  getParameter: async (_clientId: number, key: string) => params.get(key) ?? null,
}));

vi.mock('@orkoruta/db', () => ({
  withTenant: (_c: number, _r: string, fn: (tx: unknown) => unknown) =>
    fn({
      client_parameters: {
        upsert: async (args: { where: { client_id_parameter_key: { parameter_key: string } }; update: { parameter_value: string } }) => {
          upserts.push({
            key: args.where.client_id_parameter_key.parameter_key,
            value: args.update.parameter_value,
          });
          return {};
        },
      },
    }),
}));

const { instagramFeedService, INSTAGRAM_TOKEN_PARAM, INSTAGRAM_TOKEN_REFRESHED_PARAM } = await import(
  '../services/instagram_feed.service.js'
);

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const MEDIA = {
  data: [
    { id: '1', permalink: 'https://www.instagram.com/p/OLD/', media_type: 'IMAGE', timestamp: '2026-11-01T10:00:00+0000' },
    { id: '2', permalink: 'https://www.instagram.com/p/NEW/', media_type: 'VIDEO', timestamp: '2026-11-09T10:00:00+0000' },
    { id: '3', permalink: 'https://www.instagram.com/p/MID/', media_type: 'IMAGE', timestamp: '2026-11-05T10:00:00+0000' },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  params.clear();
  upserts.length = 0;
  fetchMock.mockReset();
  instagramFeedService.clearCache();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('instagramFeedService.getLatestPosts', () => {
  it('sin token: lista vacía y no llama a Instagram', async () => {
    expect(await instagramFeedService.getLatestPosts(7)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('devuelve las más recientes primero', async () => {
    params.set(INSTAGRAM_TOKEN_PARAM, 'tok');
    params.set(INSTAGRAM_TOKEN_REFRESHED_PARAM, new Date().toISOString());
    fetchMock.mockResolvedValueOnce(jsonResponse(MEDIA));

    const posts = await instagramFeedService.getLatestPosts(7, 2);
    expect(posts.map((p) => p.permalink)).toEqual([
      'https://www.instagram.com/p/NEW/',
      'https://www.instagram.com/p/MID/',
    ]);
  });

  it('usa la caché en la segunda visita', async () => {
    params.set(INSTAGRAM_TOKEN_PARAM, 'tok');
    params.set(INSTAGRAM_TOKEN_REFRESHED_PARAM, new Date().toISOString());
    fetchMock.mockResolvedValueOnce(jsonResponse(MEDIA));

    await instagramFeedService.getLatestPosts(7);
    await instagramFeedService.getLatestPosts(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renueva el token si el último refresco es viejo', async () => {
    params.set(INSTAGRAM_TOKEN_PARAM, 'viejo');
    params.set(INSTAGRAM_TOKEN_REFRESHED_PARAM, '2026-01-01T00:00:00Z');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'nuevo' }))
      .mockResolvedValueOnce(jsonResponse(MEDIA));

    await instagramFeedService.getLatestPosts(7);

    expect(String(fetchMock.mock.calls[0][0])).toContain('refresh_access_token');
    expect(String(fetchMock.mock.calls[1][0])).toContain('access_token=nuevo');
    expect(upserts.find((u) => u.key === INSTAGRAM_TOKEN_PARAM)?.value).toBe('nuevo');
  });

  it('si Instagram falla, no rompe: lista vacía', async () => {
    params.set(INSTAGRAM_TOKEN_PARAM, 'tok');
    params.set(INSTAGRAM_TOKEN_REFRESHED_PARAM, new Date().toISOString());
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid token' } }, 400));

    expect(await instagramFeedService.getLatestPosts(7)).toEqual([]);
  });
});
