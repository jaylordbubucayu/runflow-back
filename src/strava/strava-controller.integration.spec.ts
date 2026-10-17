import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StravaController } from './strava.controller';
import { StravaApiError } from './strava.errors';
import { buildHarness, dbConfigured, Harness, today } from './testing/harness';

const d = dbConfigured() ? describe : describe.skip;
const gpx = (iso = new Date(`${today()}T06:00:00+08:00`).toISOString()) =>
  `<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><trkseg><trkpt lat="16.4" lon="120.6"><time>${iso}</time></trkpt></trkseg></trk></gpx>`;
const stateFrom = (url: string) => new URL(url).searchParams.get('state')!;
const processing = { id: 555, id_str: '555', external_id: null, error: null, status: 'Your activity is still being processed.', activity_id: null };

d('Strava HTTP API (real Nest app, real JwtAuthGuard)', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.reset(); });

  async function runner() {
    const userId = await h.seedUser();
    await h.seedConnection(userId);
    const reg = await h.seedRegistration(userId);
    return { userId, token: h.jwt(userId), ...reg };
  }
  const body = (registrationId: string, over: Record<string, unknown> = {}) => ({
    registrationId, clientRequestId: randomUUID(), name: 'Fun Run', sportType: 'Run', distanceMeters: 5000,
    elapsedTimeSeconds: 1800, startDateLocal: `${today()}T00:00:00`, confirmed: true, ...over,
  });

  describe('authentication', () => {
    // Always 3 elements: with fewer, Jest passes its `done` callback as the 3rd argument and waits for it.
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/strava/status', undefined], ['GET', '/strava/connect', undefined], ['POST', '/strava/callback', { state: 'x'.repeat(30) }],
      ['DELETE', '/strava/disconnect', undefined], ['POST', '/strava/activities/manual', {}], ['POST', '/strava/activities/upload', undefined],
      ['GET', '/strava/activities', undefined], ['GET', '/strava/activities/1', undefined], ['POST', '/strava/activities/1/retry', {}],
    ];

    it.each(routes)('%s %s rejects missing credentials with 401', async (method, path, json) => {
      expect((await h.api(method, path, { json })).status).toBe(401);
    });

    it.each(routes)('%s %s rejects a forged token with 401', async (method, path, json) => {
      expect((await h.api(method, path, { json, token: 'not.a.jwt' })).status).toBe(401);
    });

    it('rejects a token signed with the wrong secret and an expired token', async () => {
      const { sign } = await import('jsonwebtoken');
      const wrong = sign({ sub: '1' }, 'other-secret');
      const expired = sign({ sub: '1' }, 'test-secret', { expiresIn: -10 });
      expect((await h.api('GET', '/strava/status', { token: wrong })).status).toBe(401);
      expect((await h.api('GET', '/strava/status', { token: expired })).status).toBe(401);
    });

    it('the controller is protected by the EXISTING JwtAuthGuard at class level (no route can bypass it)', () => {
      const guards: unknown[] = Reflect.getMetadata('__guards__', StravaController) ?? [];
      expect(guards).toContain(JwtAuthGuard);
    });

    it('there is no unauthenticated GET /strava/callback that mutates state', async () => {
      const res = await h.api('GET', '/strava/callback?code=abc&state=xyz');
      expect([401, 404]).toContain(res.status);
    });
  });

  describe('ownership comes from the token, never from the request', () => {
    it('rejects a client-supplied userId (whitelist + forbidNonWhitelisted)', async () => {
      const { token, registrationId } = await runner();
      const res = await h.api('POST', '/strava/activities/manual', { token, json: { ...body(registrationId), userId: '1' } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/userId/);
      expect(h.client.createActivity).not.toHaveBeenCalled();
    });

    it("another user cannot submit for, read, or retry someone else's records", async () => {
      const a = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      const created = await h.api('POST', '/strava/activities/manual', { token: a.token, json: body(a.registrationId) });
      expect(created.status).toBe(201);

      const intruder = await h.seedUser();
      await h.seedConnection(intruder);
      const t = h.jwt(intruder);
      expect((await h.api('POST', '/strava/activities/manual', { token: t, json: body(a.registrationId) })).status).toBe(404);
      expect((await h.api('GET', `/strava/activities/${created.body.id}`, { token: t })).status).toBe(404);
      expect((await h.api('POST', `/strava/activities/${created.body.id}/retry`, { token: t, json: { confirmNotOnStrava: true } })).status).toBe(404);
      expect((await h.api('GET', '/strava/activities', { token: t })).body).toEqual([]);
      // a filter by someone else's registrationId reveals nothing either
      expect((await h.api('GET', `/strava/activities?registrationId=${a.registrationId}`, { token: t })).body).toEqual([]);
    });

    it('non-numeric ids are 404s, not server errors', async () => {
      const { token } = await runner();
      for (const id of ['abc', '1;DROP', '-1', '1.5', '9'.repeat(30)]) {
        expect((await h.api('GET', `/strava/activities/${encodeURIComponent(id)}`, { token })).status).toBe(404);
      }
    });
  });

  describe('input validation', () => {
    it('requires explicit confirmation', async () => {
      const { token, registrationId } = await runner();
      for (const confirmed of [false, undefined, 'true', 1, null]) {
        const res = await h.api('POST', '/strava/activities/manual', { token, json: body(registrationId, { confirmed }) });
        expect(res.status).toBe(400);
      }
      expect(h.client.createActivity).not.toHaveBeenCalled();
      expect(await h.records.count()).toBe(0);
    });

    it.each([
      ['clientRequestId not a uuid', { clientRequestId: 'abc' }],
      ['unsupported sport', { sportType: 'Kitesurf' }],
      ['empty name', { name: '' }],
      ['name too long', { name: 'x'.repeat(101) }],
      ['distance too small', { distanceMeters: 5 }],
      ['distance too large', { distanceMeters: 300_000 }],
      ['distance as text', { distanceMeters: 'far' }],
      ['elapsed too small', { elapsedTimeSeconds: 10 }],
      ['elapsed too large', { elapsedTimeSeconds: 100_000 }],
      ['elapsed fractional', { elapsedTimeSeconds: 10.5 }],
      ['bad start format', { startDateLocal: 'yesterday' }],
      ['start with zone', { startDateLocal: `${today()}T05:00:00+08:00` }],
      ['description too long', { description: 'x'.repeat(501) }],
      ['registrationId not numeric', { registrationId: '1 OR 1=1' }],
    ])('rejects %s', async (_label, over) => {
      const { token, registrationId } = await runner();
      const res = await h.api('POST', '/strava/activities/manual', { token, json: body(registrationId, over) });
      expect(res.status).toBe(400);
      expect(h.client.createActivity).not.toHaveBeenCalled();
    });

    it('an unknown JSON field is rejected rather than silently ignored', async () => {
      const { token, registrationId } = await runner();
      expect((await h.api('POST', '/strava/activities/manual', { token, json: { ...body(registrationId), isAdmin: true } })).status).toBe(400);
    });
  });

  describe('manual activity over HTTP', () => {
    it('201 with the public view; replay returns the same record', async () => {
      const { token, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 4242 });
      const payload = body(registrationId);
      const a = await h.api('POST', '/strava/activities/manual', { token, json: payload });
      const b = await h.api('POST', '/strava/activities/manual', { token, json: payload });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ status: 'completed', stravaUrl: 'https://www.strava.com/activities/4242' });
      expect(b.body.id).toBe(a.body.id);
      expect(h.client.createActivity).toHaveBeenCalledTimes(1);
      const got = await h.api('GET', `/strava/activities/${a.body.id}`, { token });
      expect(got.body).toMatchObject({ id: a.body.id, event: { name: 'Baguio Fun Run' } });
    });

    it('a duplicate registration submission is a 409 with a machine-readable code', async () => {
      const { token, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      await h.api('POST', '/strava/activities/manual', { token, json: body(registrationId) });
      const res = await h.api('POST', '/strava/activities/manual', { token, json: body(registrationId) });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ statusCode: 409, error: 'STRAVA_DUPLICATE_ACTIVITY' });
    });

    it('Strava auth problems are 409/403 — NEVER 401 (the frontend logs users out on 401)', async () => {
      const { token, registrationId, userId } = await runner();
      await h.ds.query('UPDATE strava_connections SET expires_at = NOW() - INTERVAL 1 HOUR');
      h.client.refresh.mockRejectedValue(new StravaApiError('http', 401, {}));
      const res = await h.api('POST', '/strava/activities/manual', { token, json: body(registrationId) });
      expect(res.status).toBe(201); // the record is created and reports the failure...
      expect(res.body).toMatchObject({ status: 'failed', errorCode: 'STRAVA_REVOKED' });
      const retry = await h.api('POST', `/strava/activities/${res.body.id}/retry`, { token, json: {} });
      expect(retry.status).toBe(409); // ...and acting while disconnected is a 409, not a 401
      expect(retry.body.error).toBe('STRAVA_NOT_CONNECTED');
      void userId;
    });

    it('retry requires confirmation for unknown outcomes (400 → 200)', async () => {
      const { token, registrationId } = await runner();
      h.client.createActivity.mockRejectedValueOnce(new StravaApiError('network_ambiguous', null, null));
      const first = await h.api('POST', '/strava/activities/manual', { token, json: body(registrationId) });
      expect(first.body.status).toBe('needs_review');
      expect((await h.api('POST', `/strava/activities/${first.body.id}/retry`, { token, json: {} })).status).toBe(400);
      h.client.createActivity.mockResolvedValue({ id: 9 });
      const ok = await h.api('POST', `/strava/activities/${first.body.id}/retry`, { token, json: { confirmNotOnStrava: true } });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('completed');
    });
  });

  describe('multipart upload over HTTP', () => {
    const form = (registrationId: string, file?: { name: string; type: string; content: string | Buffer }, over: Record<string, string> = {}) => {
      const f = new FormData();
      f.set('registrationId', registrationId);
      f.set('clientRequestId', randomUUID());
      f.set('confirmed', 'true');
      for (const [k, v] of Object.entries(over)) f.set(k, v);
      if (file) f.set('file', new Blob([file.content as any], { type: file.type }), file.name);
      return f;
    };

    it('accepts a valid GPX and starts processing', async () => {
      const { token, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing);
      const res = await h.api('POST', '/strava/activities/upload', { token, form: form(registrationId, { name: 'run.gpx', type: 'application/gpx+xml', content: gpx() }, { name: 'Race' }) });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'processing', kind: 'upload', activityName: 'Race' });
    });

    it('requires the confirmation flag (as a multipart string)', async () => {
      const { token, registrationId } = await runner();
      const f = form(registrationId, { name: 'run.gpx', type: 'application/gpx+xml', content: gpx() }, { confirmed: 'false' });
      expect((await h.api('POST', '/strava/activities/upload', { token, form: f })).status).toBe(400);
      const g = form(registrationId, { name: 'run.gpx', type: 'application/gpx+xml', content: gpx() });
      g.delete('confirmed');
      expect((await h.api('POST', '/strava/activities/upload', { token, form: g })).status).toBe(400);
      expect(h.client.createUpload).not.toHaveBeenCalled();
    });

    it('rejects a missing file, wrong types, and spoofed content', async () => {
      const { token, registrationId } = await runner();
      const send = (f: FormData) => h.api('POST', '/strava/activities/upload', { token, form: f });
      expect((await send(form(registrationId))).status).toBe(400);
      expect((await send(form(registrationId, { name: 'run.exe', type: 'application/octet-stream', content: 'MZ' }))).status).toBe(400);
      expect((await send(form(registrationId, { name: 'run.gpx', type: 'image/png', content: gpx() }))).status).toBe(400);
      expect((await send(form(registrationId, { name: 'run.gpx', type: 'application/gpx+xml', content: '<html>not gpx</html>' }))).status).toBe(400);
      expect((await send(form(registrationId, { name: 'run.fit', type: 'application/octet-stream', content: 'plain text' }))).status).toBe(400);
      expect(h.client.createUpload).not.toHaveBeenCalled();
      expect(await h.records.count()).toBe(0);
    });

    it('enforces the size limit while streaming (413) before anything is created', async () => {
      const { token, registrationId } = await runner();
      const res = await h.api('POST', '/strava/activities/upload', {
        token, form: form(registrationId, { name: 'big.gpx', type: 'application/gpx+xml', content: Buffer.alloc(10_000, 'a') }),
      });
      expect(res.status).toBe(413);
      expect(h.client.createUpload).not.toHaveBeenCalled();
    });

    it('rejects more than one file and unexpected file fields', async () => {
      const { token, registrationId } = await runner();
      const f = form(registrationId, { name: 'run.gpx', type: 'application/gpx+xml', content: gpx() });
      f.append('file', new Blob([gpx()]), 'second.gpx');
      expect([400, 413]).toContain((await h.api('POST', '/strava/activities/upload', { token, form: f })).status);
      const g = new FormData();
      g.set('registrationId', registrationId); g.set('clientRequestId', randomUUID()); g.set('confirmed', 'true');
      g.set('attachment', new Blob([gpx()]), 'run.gpx');
      expect(h.client.createUpload).not.toHaveBeenCalled();
      expect((await h.api('POST', '/strava/activities/upload', { token, form: g })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('OAuth over HTTP', () => {
    it('connect returns the authorize URL (as JSON, so the JWT header can be used)', async () => {
      const { token } = await runner();
      const res = await h.api('GET', '/strava/connect?returnTo=%2Frunner%2Fstrava', { token });
      expect(res.status).toBe(200);
      expect(res.body.authorizeUrl).toMatch(/^https:\/\/www\.strava\.com\/oauth\/authorize\?/);
      expect(JSON.stringify(res.body)).not.toContain('test-client-secret');
    });

    it('callback: success, replay and foreign-state flows', async () => {
      const userId = await h.seedUser();
      const token = h.jwt(userId);
      const state = stateFrom((await h.api('GET', '/strava/connect', { token })).body.authorizeUrl);
      h.client.exchangeCode.mockResolvedValue({
        token_type: 'Bearer', access_token: 'AT-secret', refresh_token: 'RT-secret', expires_at: Math.floor(Date.now() / 1000) + 21_600,
        scope: 'activity:write', athlete: { id: 31337, firstname: 'Ana', lastname: 'Reyes' },
      });

      // another logged-in user presenting this state is refused
      const evil = h.jwt(await h.seedUser());
      const foreign = await h.api('POST', '/strava/callback', { token: evil, json: { state, code: 'c' } });
      expect(foreign.status).toBe(400);
      expect(foreign.body.error).toBe('STRAVA_INVALID_STATE');

      const ok = await h.api('POST', '/strava/callback', { token, json: { state, code: 'c', scope: 'activity:write' } });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ returnTo: '/runner/strava', status: { connected: true, canPublish: true, athleteName: 'Ana Reyes' } });
      expect(JSON.stringify(ok.body)).not.toMatch(/AT-secret|RT-secret/);

      const replay = await h.api('POST', '/strava/callback', { token, json: { state, code: 'c' } });
      expect(replay.status).toBe(400);
    });

    it('callback rejects malformed bodies and unknown fields', async () => {
      const { token } = await runner();
      expect((await h.api('POST', '/strava/callback', { token, json: {} })).status).toBe(400);
      expect((await h.api('POST', '/strava/callback', { token, json: { state: 'short' } })).status).toBe(400);
      expect((await h.api('POST', '/strava/callback', { token, json: { state: 'x'.repeat(40), returnTo: 'https://evil.example' } })).status).toBe(400);
    });

    it('status/disconnect round trip; no response ever contains token material', async () => {
      const { token } = await runner();
      const st = await h.api('GET', '/strava/status', { token });
      expect(st.body).toMatchObject({ configured: true, connected: true, canPublish: true });
      expect(JSON.stringify(st.body)).not.toMatch(/AT-|RT-|encrypted|access_token|refresh_token/i);
      const dis = await h.api('DELETE', '/strava/disconnect', { token });
      expect(dis.status).toBe(200);
      expect(dis.body).toEqual({ disconnected: true, revokedAtStrava: true });
      expect((await h.api('GET', '/strava/status', { token })).body).toMatchObject({ connected: false, disconnectReason: 'user' });
    });
  });

  describe('rate limiting', () => {
    it('limits connect attempts per user (429 + retry hint) without affecting other users', async () => {
      const a = h.jwt(await h.seedUser());
      const b = h.jwt(await h.seedUser());
      for (let i = 0; i < 10; i++) expect((await h.api('GET', '/strava/connect', { token: a })).status).toBe(200);
      const blocked = await h.api('GET', '/strava/connect', { token: a });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ error: 'STRAVA_RATE_LIMITED' });
      expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
      expect((await h.api('GET', '/strava/connect', { token: b })).status).toBe(200);
    });

    it('limits activity submissions per user', async () => {
      const { token, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await h.api('POST', '/strava/activities/manual', { token, json: body(registrationId) })).status);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
      expect(h.client.createActivity).toHaveBeenCalledTimes(1);
    });
  });
});

d('Strava disabled by configuration', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildHarness({ STRAVA_ENABLED: 'false' }); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.reset(); });

  it('boots, reports configured:false on status, and answers 503 elsewhere', async () => {
    const token = h.jwt(await h.seedUser());
    expect((await h.api('GET', '/strava/status', { token })).body).toMatchObject({ configured: false, connected: false });
    const res = await h.api('GET', '/strava/connect', { token });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('STRAVA_NOT_CONFIGURED');
    expect((await h.api('DELETE', '/strava/disconnect', { token })).status).toBe(503);
  });
});
