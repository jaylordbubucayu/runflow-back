import { StravaHttpClient } from './strava-http.client';
import { StravaApiError } from './strava.errors';
import { StravaConfig } from './strava.config';

const cfg = {
  clientId: 'CID', clientSecret: 'CSECRET', tokenUrl: 'https://strava.test/oauth/token', revokeUrl: 'https://strava.test/oauth/revoke',
  apiBase: 'https://strava.test/api/v3',
} as unknown as StravaConfig;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('StravaHttpClient', () => {
  let fetchMock: jest.SpyInstance;
  let client: StravaHttpClient;
  beforeEach(() => {
    client = new StravaHttpClient(cfg);
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as StravaApiError;

  it('exchanges a code with form-encoded credentials (secret only in the POST body, server-side)', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'a', refresh_token: 'r', expires_at: 1 }));
    await client.exchangeCode('CODE');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://strava.test/oauth/token');
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=CODE');
    expect(body).toContain('client_secret=CSECRET');
    expect(init.signal).toBeInstanceOf(AbortSignal); // every call has a timeout
  });

  it('revokes with HTTP Basic client credentials', async () => {
    fetchMock.mockResolvedValue(json({}));
    await client.revoke('REFRESH');
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('CID:CSECRET').toString('base64')}`);
    expect((init.body as URLSearchParams).get('token')).toBe('REFRESH');
  });

  it('sends only documented fields when creating a manual activity', async () => {
    fetchMock.mockResolvedValue(json({ id: 9 }));
    await client.createActivity('TOK', { name: 'N', sport_type: 'Run', start_date_local: '2026-10-11T05:30:00', elapsed_time: 1800, distance: 5000, description: 'd' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://strava.test/api/v3/activities');
    expect(init.headers.Authorization).toBe('Bearer TOK');
    expect([...(init.body as URLSearchParams).keys()].sort()).toEqual(['description', 'distance', 'elapsed_time', 'name', 'sport_type', 'start_date_local']);
  });

  it('uploads multipart with data_type and external_id', async () => {
    fetchMock.mockResolvedValue(json({ id: 1, status: 'x', error: null, activity_id: null, external_id: null }));
    await client.createUpload('TOK', { file: Buffer.from('abc'), dataType: 'gpx', externalId: 'runflow-5', name: 'Run' });
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('data_type')).toBe('gpx');
    expect(form.get('external_id')).toBe('runflow-5');
    expect((form.get('file') as File).name).toBe('activity.gpx');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBeUndefined(); // boundary is set by fetch
  });

  describe('failure classification (decides whether a retry could duplicate)', () => {
    it('4xx is definitely not processed', async () => {
      fetchMock.mockResolvedValue(json({ message: 'Bad Request' }, { status: 400 }));
      const e = await failure(client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 }));
      expect(e.definitelyNotProcessed).toBe(true);
    });
    it('5xx is ambiguous (server may have created it)', async () => {
      fetchMock.mockResolvedValue(new Response('<html>oops</html>', { status: 502 }));
      const e = await failure(client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 }));
      expect(e.status).toBe(502);
      expect(e.definitelyNotProcessed).toBe(false);
    });
    it('timeouts/resets are ambiguous; DNS/refused are definite', async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      expect((await failure(client.getUpload('T', '1'))).definitelyNotProcessed).toBe(false);
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
      expect((await failure(client.getUpload('T', '1'))).definitelyNotProcessed).toBe(false);
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
      expect((await failure(client.getUpload('T', '1'))).definitelyNotProcessed).toBe(true);
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      expect((await failure(client.getUpload('T', '1'))).definitelyNotProcessed).toBe(true);
    });
    it('error objects never carry request credentials', async () => {
      fetchMock.mockResolvedValue(json({}, { status: 401 }));
      const e = await failure(client.getUpload('SECRET-TOKEN', '1'));
      expect(JSON.stringify(e)).not.toContain('SECRET-TOKEN');
      expect(e.message).not.toContain('SECRET-TOKEN');
    });
  });

  describe('rate limits', () => {
    it('429 blocks further calls locally until the window rolls over, with a retry hint', async () => {
      fetchMock.mockResolvedValueOnce(json({}, { status: 429 }));
      const e = await failure(client.getUpload('T', '1'));
      expect(e.status).toBe(429);
      expect(e.retryAfterSec).toBeGreaterThan(0);
      expect(e.retryAfterSec).toBeLessThanOrEqual(900);
      const calls = fetchMock.mock.calls.length;
      const e2 = await failure(client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 }));
      expect(e2.status).toBe(429);
      expect(fetchMock.mock.calls.length).toBe(calls); // short-circuited: no request made
    });

    it('stops sending when response headers show the 15-minute budget is spent', async () => {
      fetchMock.mockResolvedValueOnce(json({ id: 1 }, { headers: { 'x-ratelimit-limit': '200,2000', 'x-ratelimit-usage': '200,300' } }));
      await client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 });
      const e = await failure(client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 }));
      expect(e.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops sending when the DAILY budget is spent, with a longer wait', async () => {
      fetchMock.mockResolvedValueOnce(json({ id: 1 }, { headers: { 'x-ratelimit-limit': '200,2000', 'x-ratelimit-usage': '5,2000' } }));
      await client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 });
      const e = await failure(client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 }));
      expect(e.status).toBe(429);
      expect(e.retryAfterSec).toBeGreaterThan(0);
    });

    it('tracks the non-upload READ budget separately from the overall budget', async () => {
      fetchMock.mockResolvedValueOnce(json({ id: 1 }, { headers: { 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '100,10', 'x-ratelimit-limit': '200,2000', 'x-ratelimit-usage': '100,10' } }));
      await client.getUpload('T', '1');
      // read budget exhausted -> polling short-circuits...
      expect((await failure(client.getUpload('T', '1'))).status).toBe(429);
      // ...but creating/uploading (overall budget only) is still allowed
      fetchMock.mockResolvedValueOnce(json({ id: 2 }));
      await expect(client.createActivity('T', { name: 'n', sport_type: 'Run', start_date_local: 'x', elapsed_time: 1 })).resolves.toBeTruthy();
    });

    it('ignores malformed rate-limit headers', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(json({ id: 1 }, { headers: { 'x-ratelimit-limit': 'abc', 'x-ratelimit-usage': 'zzz' } })));
      await client.getUpload('T', '1');
      await client.getUpload('T', '1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
