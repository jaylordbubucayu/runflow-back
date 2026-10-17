import { createHash } from 'crypto';
import { StravaApiError } from './strava.errors';
import { buildHarness, dbConfigured, expectHttp, Harness } from './testing/harness';

const d = dbConfigured() ? describe : describe.skip;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const future = () => Math.floor(Date.now() / 1000) + 21_600;
const tokenResponse = (over: Record<string, unknown> = {}) => ({
  token_type: 'Bearer', access_token: 'AT-plain', refresh_token: 'RT-plain', expires_at: future(), scope: 'activity:write',
  athlete: { id: 424242, firstname: 'Juan', lastname: 'Dela Cruz' }, ...over,
});
const stateFrom = (url: string) => new URL(url).searchParams.get('state')!;

d('Strava OAuth (database-backed)', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.reset(); });

  describe('start', () => {
    it('builds a Strava authorize URL with the minimum scope and a server-side state', async () => {
      const u = await h.seedUser();
      const { authorizeUrl } = await h.auth.start(u);
      const url = new URL(authorizeUrl);
      expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('99999');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/runner/strava/callback');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('activity:write');
      expect(authorizeUrl).not.toContain('test-client-secret');
      expect(stateFrom(authorizeUrl).length).toBeGreaterThanOrEqual(40);
    });

    it('stores only the HASH of the state, bound to the user, expiring in ~10 minutes', async () => {
      const u = await h.seedUser();
      const state = stateFrom((await h.auth.start(u)).authorizeUrl);
      const rows = await h.states.find();
      expect(rows).toHaveLength(1);
      expect(rows[0].stateHash).toBe(sha(state));
      expect(JSON.stringify(rows)).not.toContain(state);
      expect(rows[0].userId).toBe(u);
      const ttl = rows[0].expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 2000);
    });

    it('generates unique states', async () => {
      const u = await h.seedUser();
      const a = stateFrom((await h.auth.start(u)).authorizeUrl);
      const b = stateFrom((await h.auth.start(u)).authorizeUrl);
      expect(a).not.toBe(b);
    });

    it.each([
      ['https://evil.example/steal', '/runner/strava'],
      ['//evil.example', '/runner/strava'],
      ['/\\evil.example', '/runner/strava'],
      ['/runner/../admin', '/runner/strava'],
      ['/admin/users', '/runner/strava'],
      ['javascript:alert(1)', '/runner/strava'],
      ['/runner/registrations/12', '/runner/registrations/12'],
      ['/runner', '/runner'],
    ])('returnTo %p is stored as %p (allow-list of runner paths only)', async (given, expected) => {
      const u = await h.seedUser();
      await h.auth.start(u, given);
      expect((await h.states.find())[0].returnTo).toBe(expected);
    });

    it('opportunistically purges states older than a day', async () => {
      const u = await h.seedUser();
      await h.auth.start(u);
      await h.ds.query("UPDATE strava_oauth_states SET expires_at = NOW() - INTERVAL 3 DAY");
      await h.auth.start(u);
      expect(await h.states.count()).toBe(1);
    });
  });

  describe('complete', () => {
    async function begin(userId: string, returnTo?: string) {
      return stateFrom((await h.auth.start(userId, returnTo)).authorizeUrl);
    }

    it('exchanges the code, persists the connection, and encrypts both tokens at rest', async () => {
      const u = await h.seedUser();
      const state = await begin(u, '/runner/registrations/9');
      h.client.exchangeCode.mockResolvedValue(tokenResponse());

      const res = await h.auth.complete(u, { state, code: 'CODE', scope: 'activity:write' });

      expect(h.client.exchangeCode).toHaveBeenCalledWith('CODE');
      expect(res.returnTo).toBe('/runner/registrations/9'); // from the server-side record, not the callback
      expect(res.status).toMatchObject({ connected: true, canPublish: true, athleteId: '424242', athleteName: 'Juan Dela Cruz', scopes: ['activity:write'] });
      expect(JSON.stringify(res)).not.toMatch(/AT-plain|RT-plain|token/i);

      const [row] = await h.ds.query('SELECT * FROM strava_connections');
      expect(row.access_token_encrypted).not.toContain('AT-plain');
      expect(row.refresh_token_encrypted).not.toContain('RT-plain');
      expect(h.crypto.decrypt(row.access_token_encrypted, u)).toBe('AT-plain');
      expect(h.crypto.decrypt(row.refresh_token_encrypted, u)).toBe('RT-plain');
      expect(String(row.strava_athlete_id)).toBe('424242');
      expect(row.is_connected).toBe(1);
    });

    it('state is single-use: a replay is rejected and Strava is not called again', async () => {
      const u = await h.seedUser();
      const state = await begin(u);
      h.client.exchangeCode.mockResolvedValue(tokenResponse());
      await h.auth.complete(u, { state, code: 'CODE' });
      await expectHttp(h.auth.complete(u, { state, code: 'CODE' }), 400, 'STRAVA_INVALID_STATE');
      expect(h.client.exchangeCode).toHaveBeenCalledTimes(1);
    });

    it('concurrent callbacks with one state: exactly one wins', async () => {
      const u = await h.seedUser();
      const state = await begin(u);
      h.client.exchangeCode.mockResolvedValue(tokenResponse());
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => h.auth.complete(u, { state, code: 'CODE' })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(h.client.exchangeCode).toHaveBeenCalledTimes(1);
    });

    it("rejects another user's state (login-CSRF) without consuming it or calling Strava", async () => {
      const victim = await h.seedUser();
      const attacker = await h.seedUser();
      const state = await begin(attacker); // attacker starts a flow and tricks the victim into finishing it
      await expectHttp(h.auth.complete(victim, { state, code: 'CODE' }), 400, 'STRAVA_INVALID_STATE');
      expect(h.client.exchangeCode).not.toHaveBeenCalled();
      expect(await h.connections.count()).toBe(0);
      // the rightful owner can still use it
      h.client.exchangeCode.mockResolvedValue(tokenResponse());
      await expect(h.auth.complete(attacker, { state, code: 'CODE' })).resolves.toBeTruthy();
    });

    it('rejects expired, unknown and malformed states', async () => {
      const u = await h.seedUser();
      const state = await begin(u);
      await h.ds.query('UPDATE strava_oauth_states SET expires_at = NOW() - INTERVAL 1 MINUTE');
      await expectHttp(h.auth.complete(u, { state, code: 'C' }), 400, 'STRAVA_INVALID_STATE');
      await expectHttp(h.auth.complete(u, { state: 'x'.repeat(43), code: 'C' }), 400, 'STRAVA_INVALID_STATE');
      expect(h.client.exchangeCode).not.toHaveBeenCalled();
    });

    it('handles the user declining on Strava (access_denied) and consumes the state', async () => {
      const u = await h.seedUser();
      const state = await begin(u);
      await expectHttp(h.auth.complete(u, { state, error: 'access_denied' }), 400, 'STRAVA_ACCESS_DENIED');
      expect(h.client.exchangeCode).not.toHaveBeenCalled();
      await expectHttp(h.auth.complete(u, { state, code: 'C' }), 400, 'STRAVA_INVALID_STATE');
    });

    it('requires a code when there is no error', async () => {
      const u = await h.seedUser();
      const state = await begin(u);
      await expectHttp(h.auth.complete(u, { state }), 400, 'STRAVA_INVALID_STATE');
    });

    it('refuses a grant without activity:write (user unticked it), stores nothing, and cleans up the grant', async () => {
      const u = await h.seedUser();
      const state = await begin(u);
      h.client.exchangeCode.mockResolvedValue(tokenResponse({ scope: 'read' }));
      await expectHttp(h.auth.complete(u, { state, code: 'C' }), 400, 'STRAVA_MISSING_SCOPE');
      expect(await h.connections.count()).toBe(0);
      expect(h.client.revoke).toHaveBeenCalledWith('RT-plain');
    });

    it('does NOT revoke a scope-less grant when that athlete is already linked (it would kill the other connection)', async () => {
      const owner = await h.seedUser();
      await h.seedConnection(owner, { athleteId: '424242' });
      const u = await h.seedUser();
      const state = await begin(u);
      h.client.exchangeCode.mockResolvedValue(tokenResponse({ scope: 'read' }));
      await expectHttp(h.auth.complete(u, { state, code: 'C' }), 400, 'STRAVA_MISSING_SCOPE');
      expect(h.client.revoke).not.toHaveBeenCalled();
    });

    it('falls back to the callback scope parameter when the token response has none', async () => {
      const u = await h.seedUser();
      const state = await begin(u);
      h.client.exchangeCode.mockResolvedValue(tokenResponse({ scope: undefined }));
      await expect(h.auth.complete(u, { state, code: 'C', scope: 'read,activity:write' })).resolves.toMatchObject({ status: { canPublish: true } });
    });

    it('refuses a Strava account already connected to a different RunFlow user, and never revokes it', async () => {
      const first = await h.seedUser();
      await h.seedConnection(first, { athleteId: '424242' });
      const second = await h.seedUser();
      const state = await begin(second);
      h.client.exchangeCode.mockResolvedValue(tokenResponse());
      await expectHttp(h.auth.complete(second, { state, code: 'C' }), 409, 'STRAVA_ATHLETE_LINKED');
      expect(h.client.revoke).not.toHaveBeenCalled();
      expect(await h.connections.count({ where: { userId: second } })).toBe(0);
      expect((await h.connections.findOneBy({ userId: first }))?.isConnected).toBe(true);
    });

    it('reconnecting the same user updates the one row (no duplicates)', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { athleteId: '424242', connected: false });
      const state = await begin(u);
      h.client.exchangeCode.mockResolvedValue(tokenResponse());
      await h.auth.complete(u, { state, code: 'C' });
      expect(await h.connections.count()).toBe(1);
      expect(await h.auth.getStatus(u)).toMatchObject({ connected: true, disconnectReason: null });
    });

    it('maps Strava failures safely', async () => {
      const u = await h.seedUser();
      h.client.exchangeCode.mockRejectedValueOnce(new StravaApiError('http', 400, { message: 'Bad Request', errors: [{ code: 'invalid' }] }));
      await expectHttp(h.auth.complete(u, { state: await begin(u), code: 'C' }), 400, 'STRAVA_INVALID_STATE');
      h.client.exchangeCode.mockRejectedValueOnce(new StravaApiError('http', 503, '<html>down</html>'));
      const err = await expectHttp(h.auth.complete(u, { state: await begin(u), code: 'C' }), 503, 'STRAVA_UNAVAILABLE');
      expect(JSON.stringify(err.getResponse())).not.toContain('<html>');
      h.client.exchangeCode.mockRejectedValueOnce(new StravaApiError('http', 429, null, 600));
      await expectHttp(h.auth.complete(u, { state: await begin(u), code: 'C' }), 429, 'STRAVA_RATE_LIMITED');
      h.client.exchangeCode.mockResolvedValueOnce({ access_token: 'x' }); // incomplete payload
      await expectHttp(h.auth.complete(u, { state: await begin(u), code: 'C' }), 502, 'STRAVA_UPSTREAM_ERROR');
    });
  });

  describe('status & disconnect', () => {
    it('reports disconnected for users who never connected', async () => {
      const u = await h.seedUser();
      expect(await h.auth.getStatus(u)).toMatchObject({ configured: true, connected: false, canPublish: false, athleteId: null, scopes: [] });
    });

    it('status never exposes token material', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u);
      const json = JSON.stringify(await h.auth.getStatus(u));
      expect(json).not.toMatch(/AT-|RT-|encrypted|token|secret/i);
      expect(JSON.parse(json).profileUrl).toBe(`https://www.strava.com/athletes/${1_000_000 + Number(u)}`);
    });

    it('a connection without activity:write is connected but cannot publish', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { scopes: 'read' });
      expect(await h.auth.getStatus(u)).toMatchObject({ connected: true, canPublish: false });
    });

    it('disconnect revokes the refresh token at Strava, wipes credentials, and frees the athlete', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { athleteId: '424242' });
      const res = await h.auth.disconnect(u);
      expect(res).toEqual({ disconnected: true, revokedAtStrava: true });
      expect(h.client.revoke).toHaveBeenCalledWith(`RT-${u}`);
      const [row] = await h.ds.query('SELECT * FROM strava_connections');
      expect(row).toMatchObject({ is_connected: 0, access_token_encrypted: null, refresh_token_encrypted: null, strava_athlete_id: null, disconnect_reason: 'user' });
      // a different RunFlow account may now connect that Strava athlete
      const other = await h.seedUser();
      h.client.exchangeCode.mockResolvedValue(tokenResponse());
      const state = stateFrom((await h.auth.start(other)).authorizeUrl);
      await expect(h.auth.complete(other, { state, code: 'C' })).resolves.toBeTruthy();
    });

    it('still disconnects locally if Strava is unreachable, and says it could not revoke', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u);
      h.client.revoke.mockRejectedValue(new StravaApiError('network_ambiguous', null, null));
      expect(await h.auth.disconnect(u)).toEqual({ disconnected: true, revokedAtStrava: false });
      expect((await h.auth.getStatus(u)).connected).toBe(false);
    });

    it('disconnect is idempotent', async () => {
      const u = await h.seedUser();
      expect(await h.auth.disconnect(u)).toEqual({ disconnected: true, revokedAtStrava: false });
      await h.seedConnection(u);
      await h.auth.disconnect(u);
      await h.auth.disconnect(u);
      expect(h.client.revoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('token management', () => {
    const refreshed = (n = 1) => ({ access_token: `AT-new-${n}`, refresh_token: `RT-new-${n}`, expires_at: future(), token_type: 'Bearer' });

    it('uses the stored token while it is comfortably valid (no refresh call)', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u);
      expect(await h.tokens.getAccessToken(u)).toBe(`AT-${u}`);
      expect(h.client.refresh).not.toHaveBeenCalled();
    });

    it('refreshes before expiry and persists BOTH rotated tokens encrypted', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { expiresInSec: 120 }); // inside the 10-minute skew
      h.client.refresh.mockResolvedValue(refreshed());
      expect(await h.tokens.getAccessToken(u)).toBe('AT-new-1');
      expect(h.client.refresh).toHaveBeenCalledWith(`RT-${u}`);
      const [row] = await h.ds.query('SELECT * FROM strava_connections');
      expect(row.access_token_encrypted).not.toContain('AT-new-1');
      expect(h.crypto.decrypt(row.refresh_token_encrypted, u)).toBe('RT-new-1'); // rotation handled
      expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 5 * 3600_000);
      // next call is served from storage
      expect(await h.tokens.getAccessToken(u)).toBe('AT-new-1');
      expect(h.client.refresh).toHaveBeenCalledTimes(1);
    });

    it('refreshes an already-expired token', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { expiresInSec: -3600 });
      h.client.refresh.mockResolvedValue(refreshed());
      expect(await h.tokens.getAccessToken(u)).toBe('AT-new-1');
    });

    it('concurrent callers trigger exactly ONE refresh (row lock) and all get the same token', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { expiresInSec: -10 });
      h.client.refresh.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 150)); return refreshed(); });
      const tokens = await Promise.all(Array.from({ length: 8 }, () => h.tokens.getAccessToken(u)));
      expect(new Set(tokens)).toEqual(new Set(['AT-new-1']));
      expect(h.client.refresh).toHaveBeenCalledTimes(1);
    });

    it('a transient refresh failure leaves the connection intact and reports 503', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { expiresInSec: -10 });
      h.client.refresh.mockRejectedValue(new StravaApiError('http', 502, '<html/>'));
      await expectHttp(h.tokens.getAccessToken(u), 503, 'STRAVA_UNAVAILABLE');
      expect(await h.auth.getStatus(u)).toMatchObject({ connected: true });
    });

    it('a rejected refresh token means the user revoked access: connection is disconnected with reason, 409 not 401', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u, { expiresInSec: -10 });
      h.client.refresh.mockRejectedValue(new StravaApiError('http', 400, { message: 'Bad Request' }));
      await expectHttp(h.tokens.getAccessToken(u), 409, 'STRAVA_REVOKED');
      expect(await h.auth.getStatus(u)).toMatchObject({ connected: false, disconnectReason: 'revoked' });
      const [row] = await h.ds.query('SELECT * FROM strava_connections');
      expect(row.access_token_encrypted).toBeNull();
      expect(row.refresh_token_encrypted).toBeNull();
      await expectHttp(h.tokens.getAccessToken(u), 409, 'STRAVA_NOT_CONNECTED');
    });

    it('withToken: a 401 triggers one refresh and one retry, then succeeds', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u);
      h.client.refresh.mockResolvedValue(refreshed());
      const fn = jest.fn().mockRejectedValueOnce(new StravaApiError('http', 401, {})).mockResolvedValueOnce('ok');
      await expect(h.tokens.withToken(u, fn)).resolves.toBe('ok');
      expect(fn.mock.calls.map((c) => c[0])).toEqual([`AT-${u}`, 'AT-new-1']);
    });

    it('withToken: if another request already refreshed, the stale-401 path reuses that token (no second refresh)', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u);
      h.client.refresh.mockResolvedValue(refreshed());
      const fn = jest.fn().mockImplementation(async (t: string) => {
        if (t === `AT-${u}`) {
          // simulate a concurrent refresh landing while this call was in flight
          await h.tokens.getAccessToken(u).catch(() => undefined);
          await h.ds.query('UPDATE strava_connections SET expires_at = NOW() + INTERVAL 5 HOUR');
          const row = await h.connections.findOneByOrFail({ userId: u });
          row.accessTokenEncrypted = h.crypto.encrypt('AT-by-other-request', u);
          await h.connections.save(row);
          throw new StravaApiError('http', 401, {});
        }
        return t;
      });
      await expect(h.tokens.withToken(u, fn)).resolves.toBe('AT-by-other-request');
      expect(h.client.refresh).not.toHaveBeenCalled();
    });

    it('withToken: a 403 flags the connection as lacking permission', async () => {
      const u = await h.seedUser();
      await h.seedConnection(u);
      await expect(h.tokens.withToken(u, async () => { throw new StravaApiError('http', 403, {}); })).rejects.toBeInstanceOf(StravaApiError);
      expect(await h.auth.getStatus(u)).toMatchObject({ connected: false, disconnectReason: 'insufficient_scope' });
    });

    it('throws NOT_CONNECTED for users without a connection', async () => {
      const u = await h.seedUser();
      await expectHttp(h.tokens.getAccessToken(u), 409, 'STRAVA_NOT_CONNECTED');
    });

    it('a ciphertext copied onto another user row cannot be used (AAD binding)', async () => {
      const a = await h.seedUser();
      const b = await h.seedUser();
      const connA = await h.seedConnection(a);
      const connB = await h.seedConnection(b);
      await h.connections.update(connB.id, { accessTokenEncrypted: connA.accessTokenEncrypted });
      await expect(h.tokens.getAccessToken(b)).rejects.toThrow('Token decryption failed');
    });
  });
});
