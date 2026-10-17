// AuthService (imported transitively) pulls in bcrypt's native binary, which these tests never use.
jest.mock('bcrypt', () => ({}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, DeepPartial } from 'typeorm';
import { dataSourceOptions } from '../../data-source';
import { User } from '../../users/entities/user.entity';
import { RunnerProfile } from '../../users/entities/runner-profile.entity';
import { AuthService } from '../auth.service';
import { OauthLoginCode } from './entities/oauth-login-code.entity';
import { GoogleAuthConfig } from './google.config';
import { GoogleOAuthClient } from './google-oauth.client';
import { GoogleAuthService } from './google-auth.service';
import { GoogleAuthController } from './google-auth.controller';

/**
 * Real Nest app + real controller/service/client + real database. Only Google's token endpoint is
 * faked (at `fetch`). Needs the same STRAVA_TEST_DB_* variables as the Strava suites; the database
 * name must end in `_test` because the harness TRUNCATEs users.
 */
const enabled = !!process.env.STRAVA_TEST_DB_NAME;
const d = enabled ? describe : describe.skip;

const CID = '1234.apps.googleusercontent.com';
const CALLBACK = 'http://localhost:3000/api/auth/google/callback';
const ENV = {
  GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: 'google-test-secret', GOOGLE_CALLBACK_URL: CALLBACK,
  FRONTEND_URL: 'https://app.test', JWT_ACCESS_SECRET: 'access-secret-0123456789abcdef', JWT_REFRESH_SECRET: 'refresh-secret-0123456789abcdef',
};
const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const realFetch = globalThis.fetch;

type Claims = Record<string, unknown>;
const googleReply = { next: null as null | (() => Response | Promise<Response>), calls: [] as Array<{ url: string; body: Record<string, string> }> };

async function build(overrides: Record<string, string | undefined> = {}) {
  const env = { ...ENV, ...overrides } as Record<string, string>;
  for (const k of ['NODE_ENV']) delete process.env[k];
  for (const k of Object.keys(ENV)) delete process.env[k];
  Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
  const stubAuth = { issueTokens: async (u: User) => ({ accessToken: await jwt.signAsync({ sub: u.id, email: u.email, role: u.role }), refreshToken: 'refresh-for-' + u.id }) };
  let jwt!: JwtService;
  const mod = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
      TypeOrmModule.forRoot({
        ...dataSourceOptions, host: process.env.STRAVA_TEST_DB_HOST ?? '127.0.0.1', port: Number(process.env.STRAVA_TEST_DB_PORT ?? 3306),
        username: process.env.STRAVA_TEST_DB_USER, password: process.env.STRAVA_TEST_DB_PASSWORD, database: process.env.STRAVA_TEST_DB_NAME, logging: false, retryAttempts: 0,
      } as any),
      TypeOrmModule.forFeature([User, RunnerProfile, OauthLoginCode]),
      JwtModule.register({ secret: env.JWT_ACCESS_SECRET }),
    ],
    controllers: [GoogleAuthController],
    providers: [GoogleAuthConfig, GoogleOAuthClient, GoogleAuthService, { provide: AuthService, useValue: stubAuth }],
  }).compile();
  jwt = mod.get(JwtService);
  const app: INestApplication = mod.createNestApplication();
  // Same options as main.ts — forbidNonWhitelisted is what makes the callback's "no DTO" rule matter.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  await app.listen(0);
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const ds = mod.get(DataSource);
  return { app, base, ds, jwt, users: ds.getRepository(User), profiles: ds.getRepository(RunnerProfile), codes: ds.getRepository(OauthLoginCode) };
}

d('Google sign-in (real app, real DB, faked Google)', () => {
  let h: Awaited<ReturnType<typeof build>>;
  let tokenSpy: jest.SpyInstance;

  beforeAll(async () => { h = await build(); });
  afterAll(async () => { await h.app.close(); });
  beforeEach(async () => {
    const qr = h.ds.createQueryRunner();
    await qr.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of ['oauth_login_codes', 'runner_profiles', 'users']) await qr.query(`TRUNCATE TABLE \`${t}\``);
    await qr.query('SET FOREIGN_KEY_CHECKS=1');
    await qr.release();
    googleReply.next = null;
    googleReply.calls = [];
    // Route Google's token endpoint to the fake; everything else (our own app) goes to the real fetch.
    tokenSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url ?? String(input);
      if (url.startsWith('https://oauth2.googleapis.com/')) {
        googleReply.calls.push({ url, body: Object.fromEntries(init.body as URLSearchParams) });
        if (!googleReply.next) throw new Error('unexpected call to Google');
        return googleReply.next();
      }
      return realFetch(input, init);
    });
  });
  afterEach(() => tokenSpy.mockRestore());

  // ---- helpers ---------------------------------------------------------------------------------
  const idToken = (nonce: string, over: Claims = {}) =>
    `${seg({ alg: 'RS256' })}.${seg({
      iss: 'https://accounts.google.com', aud: CID, azp: CID, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) - 5,
      nonce, sub: 'g-sub-1', email: 'ana@example.com', email_verified: true, given_name: 'Ana', family_name: 'Reyes', ...over,
    })}.sig`;

  async function start(qs = '') {
    const res = await fetch(`${h.base}/api/auth/google${qs}`, { redirect: 'manual' });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const location = res.headers.get('location') ?? '';
    const g = location.startsWith('https://accounts.google.com') ? new URL(location) : null;
    return {
      res, status: res.status, location, setCookie: setCookie[0] ?? '',
      cookie: (setCookie[0] ?? '').split(';')[0], // name=value, what the browser would send back
      state: g?.searchParams.get('state') ?? '', nonce: g?.searchParams.get('nonce') ?? '', challenge: g?.searchParams.get('code_challenge') ?? '',
    };
  }

  /** Whole flow: start → (Google) → callback. Claims are merged over sane defaults. */
  async function signIn(o: { qs?: string; claims?: Claims; reply?: () => Response; tamper?: (f: Awaited<ReturnType<typeof start>>) => { cookie?: string; state?: string }; callbackQuery?: string } = {}) {
    const f = await start(o.qs);
    googleReply.next = o.reply ?? (() => new Response(JSON.stringify({ id_token: idToken(f.nonce, o.claims) }), { status: 200 }));
    const t = o.tamper?.(f) ?? {};
    const q = o.callbackQuery ?? `code=AUTHCODE&state=${encodeURIComponent(t.state ?? f.state)}`;
    const cb = await fetch(`${h.base}/api/auth/google/callback?${q}`, { redirect: 'manual', headers: { Cookie: t.cookie ?? f.cookie } });
    const loc = cb.headers.get('location') ?? '';
    const u = loc ? new URL(loc) : null;
    return {
      f, cb, status: cb.status, location: loc,
      loginCode: u?.pathname === '/auth/google/callback' ? u.searchParams.get('code') ?? '' : '',
      error: u?.searchParams.get('googleError') ?? null, setCookie: cb.headers.getSetCookie?.() ?? [],
    };
  }
  const exchange = (code: unknown) =>
    fetch(`${h.base}/api/auth/google/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
      .then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  const mkUser = (over: Partial<User> = {}): Promise<User> => h.users.save(h.users.create({ email: 'ana@example.com', ...over } as DeepPartial<User>));
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  // ===============================================================================================
  describe('GET /auth/google (start)', () => {
    it('redirects to Google with PKCE, a nonce and a state — and never exposes the client secret', async () => {
      const s = await start();
      expect(s.status).toBe(302);
      const u = new URL(s.location);
      expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(u.searchParams.get('client_id')).toBe(CID);
      expect(u.searchParams.get('redirect_uri')).toBe(CALLBACK);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      expect(s.state.length).toBeGreaterThanOrEqual(43);
      expect(s.nonce.length).toBeGreaterThanOrEqual(43);
      expect(s.location).not.toContain('google-test-secret');
      expect(s.res.headers.get('cache-control')).toBe('no-store');
    });

    it('binds the attempt to this browser with a signed, HttpOnly, SameSite=Lax cookie scoped to the auth path', async () => {
      const s = await start();
      expect(s.setCookie).toMatch(/^rf_google_oauth=/);
      expect(s.setCookie).toMatch(/HttpOnly/i);
      expect(s.setCookie).toMatch(/SameSite=Lax/i);
      expect(s.setCookie).toMatch(/Path=\/api\/auth\/google(;|$)/);
      expect(s.setCookie).toMatch(/Max-Age=600/);
      expect(s.setCookie).not.toMatch(/Secure/i); // not production here
      expect(s.setCookie.split('=')[1]).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;?/); // payload.signature
    });

    it("sends a PKCE challenge that matches the verifier kept in the cookie (and that verifier never goes to Google's URL)", async () => {
      const s = await start();
      const payload = JSON.parse(Buffer.from(s.cookie.split('=')[1].split('.')[0], 'base64url').toString());
      expect(createHash('sha256').update(payload.v).digest('base64url')).toBe(s.challenge);
      expect(s.location).not.toContain(payload.v);
    });

    it('uses a fresh state/nonce every time', async () => {
      const [a, b] = [await start(), await start()];
      expect(a.state).not.toBe(b.state);
      expect(a.nonce).not.toBe(b.nonce);
    });

    it.each([['admin'], ['superuser'], ['']])('rejects role=%p with 400 (admin can never be self-selected)', async (role) => {
      const res = await fetch(`${h.base}/api/auth/google?role=${role}`, { redirect: 'manual' });
      expect(res.status).toBe(400);
    });

    it('accepts runner/organizer, and rejects unknown query params (forbidNonWhitelisted)', async () => {
      expect((await start('?role=organizer')).status).toBe(302);
      expect((await start('?role=runner&redirect=%2Frunner')).status).toBe(302);
      expect((await fetch(`${h.base}/api/auth/google?evil=1`, { redirect: 'manual' })).status).toBe(400);
    });

    it('is a 302 to the frontend with a machine-readable error when Google is not configured', async () => {
      const off = await build({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_CALLBACK_URL: '' });
      try {
        const res = await fetch(`${off.base}/api/auth/google`, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://app.test/login?googleError=not_configured');
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally { await off.app.close(); }
    });

    it('marks the cookie Secure in production', async () => {
      const prod = await build({ NODE_ENV: 'production', GOOGLE_CALLBACK_URL: 'https://api.test/api/auth/google/callback' });
      try {
        const res = await fetch(`${prod.base}/api/auth/google`, { redirect: 'manual' });
        expect(res.headers.getSetCookie()[0]).toMatch(/Secure/i);
      } finally { await prod.app.close(); }
    });
  });

  // ===============================================================================================
  describe('GET /auth/google/callback', () => {
    it('creates a runner account for a new Google user, with a profile and NO password, and hands off a one-time code', async () => {
      const r = await signIn();
      expect(r.status).toBe(302);
      expect(r.error).toBeNull();
      expect(r.location).toMatch(/^https:\/\/app\.test\/auth\/google\/callback\?code=[A-Za-z0-9_-]{43}$/);
      const [u] = await h.users.find();
      expect(u).toMatchObject({ email: 'ana@example.com', googleId: 'g-sub-1', role: 'runner', isActive: true, isGuest: false });
      const [raw] = await h.ds.query('SELECT password_hash FROM users');
      expect(raw.password_hash).toBeNull();
      expect(await h.profiles.findOneBy({ userId: u.id })).toMatchObject({ firstName: 'Ana', lastName: 'Reyes' });
    });

    it('never puts tokens (or anything JWT-shaped) in the redirect URL, and clears the state cookie', async () => {
      const r = await signIn();
      expect(r.location).not.toMatch(/eyJ|access|refresh|token/i);
      expect(r.setCookie.join(';')).toMatch(/rf_google_oauth=;/);
      expect(r.setCookie.join(';')).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(r.cb.headers.get('cache-control')).toBe('no-store');
    });

    it('exchanges the code at Google server-side with the PKCE verifier from the cookie and the client secret', async () => {
      const r = await signIn();
      expect(googleReply.calls).toHaveLength(1);
      const { url, body } = googleReply.calls[0];
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const payload = JSON.parse(Buffer.from(r.f.cookie.split('=')[1].split('.')[0], 'base64url').toString());
      expect(body).toMatchObject({ code: 'AUTHCODE', code_verifier: payload.v, client_secret: 'google-test-secret', redirect_uri: CALLBACK, grant_type: 'authorization_code' });
    });

    it('accepts the extra params Google appends (scope, authuser, prompt, hd) instead of 400-ing', async () => {
      const f = await start();
      googleReply.next = () => new Response(JSON.stringify({ id_token: idToken(f.nonce) }), { status: 200 });
      const cb = await fetch(`${h.base}/api/auth/google/callback?code=C&state=${f.state}&scope=email%20profile%20openid&authuser=0&prompt=consent&hd=example.com`, { redirect: 'manual', headers: { Cookie: f.cookie } });
      expect(cb.status).toBe(302);
      expect(cb.headers.get('location')).toMatch(/\/auth\/google\/callback\?code=/);
    });

    // ----- role handling -------------------------------------------------------------------------
    it('honours role=organizer for a brand-new account only', async () => {
      await signIn({ qs: '?role=organizer', claims: { sub: 'g-org', email: 'org@example.com' } });
      expect(await h.users.findOneBy({ email: 'org@example.com' })).toMatchObject({ role: 'organizer' });
    });

    it('NEVER changes the role of an existing account, whatever the browser asked for', async () => {
      await mkUser({ email: 'ana@example.com', role: 'runner' as any });
      await signIn({ qs: '?role=organizer' });
      expect((await h.users.findOneBy({ email: 'ana@example.com' }))?.role).toBe('runner');
    });

    it('lets an existing admin sign in with Google and stays admin (no demotion, no escalation path)', async () => {
      await mkUser({ email: 'boss@example.com', role: 'admin' as any });
      const r = await signIn({ claims: { sub: 'g-boss', email: 'boss@example.com' } });
      expect(r.error).toBeNull();
      expect((await h.users.findOneBy({ email: 'boss@example.com' }))?.role).toBe('admin');
    });

    // ----- account linking ---------------------------------------------------------------------------
    it('links Google to an existing password account by verified email (case-insensitive) without duplicating or altering it', async () => {
      const existing = await mkUser({ email: 'ana@example.com', passwordHash: 'bcrypt-hash-placeholder' } as any);
      await h.profiles.save(h.profiles.create({ userId: existing.id, firstName: 'Original', lastName: 'Name' }));
      const r = await signIn({ claims: { email: 'ANA@Example.COM' } });
      expect(r.error).toBeNull();
      expect(await h.users.count()).toBe(1);
      expect((await h.users.findOneBy({ id: existing.id }))?.googleId).toBe('g-sub-1');
      const [raw] = await h.ds.query('SELECT password_hash FROM users');
      expect(raw.password_hash).toBe('bcrypt-hash-placeholder'); // password login keeps working
      expect(await h.profiles.count()).toBe(1);
      expect((await h.profiles.findOneBy({ userId: existing.id }))?.firstName).toBe('Original'); // existing profile untouched
    });

    it('finds a returning user by Google id even if their Google email changed', async () => {
      const u = await mkUser({ email: 'old@example.com', googleId: 'g-sub-1' });
      const r = await signIn({ claims: { sub: 'g-sub-1', email: 'new@example.com' } });
      expect(r.error).toBeNull();
      expect(await h.users.count()).toBe(1);
      const ex = await exchange(r.loginCode);
      expect(h.jwt.decode(ex.body.accessToken)).toMatchObject({ sub: u.id, email: 'old@example.com' });
    });

    it('refuses to link when the RunFlow account is already tied to a DIFFERENT Google account', async () => {
      await mkUser({ email: 'ana@example.com', googleId: 'someone-else' });
      const r = await signIn({ claims: { sub: 'attacker-google-id' } });
      expect(r.error).toBe('account_conflict');
      expect((await h.users.findOneBy({ email: 'ana@example.com' }))?.googleId).toBe('someone-else');
      expect(await h.codes.count()).toBe(0);
    });

    it('never links on an UNVERIFIED Google email (account-takeover guard) and creates nothing', async () => {
      await mkUser({ email: 'ana@example.com' });
      const r = await signIn({ claims: { email_verified: false } });
      expect(r.error).toBe('email_unverified');
      expect((await h.users.findOneBy({ email: 'ana@example.com' }))?.googleId).toBeNull();
      expect(await h.codes.count()).toBe(0);
    });

    it('claims a guest-checkout shadow account for whoever proves the email, keeping the same user id', async () => {
      const guest = await mkUser({ email: 'ana@example.com', isGuest: true });
      await signIn();
      const after = await h.users.findOneBy({ email: 'ana@example.com' });
      expect(after).toMatchObject({ id: guest.id, isGuest: false, googleId: 'g-sub-1' });
      expect(await h.profiles.findOneBy({ userId: guest.id })).toBeTruthy(); // profile created if missing
    });

    it('creates a profile for a linked account that lacks one, once', async () => {
      const u = await mkUser();
      await signIn();
      await signIn();
      expect(await h.profiles.count({ where: { userId: u.id } })).toBe(1);
    });

    it.each([
      ['given/family name missing', { given_name: undefined, family_name: undefined }, 'ana', ''],
      ['very long names', { given_name: 'A'.repeat(300), family_name: 'B'.repeat(300) }, 'A'.repeat(100), 'B'.repeat(100)],
    ])('builds a safe profile when %s', async (_l, claims, first, last) => {
      await signIn({ claims });
      expect(await h.profiles.findOneBy({})).toMatchObject({ firstName: first, lastName: last });
    });

    // ----- suspended accounts ------------------------------------------------------------------------
    it('blocks suspended accounts, found by Google id OR by email, and issues no code', async () => {
      await mkUser({ email: 'a@example.com', googleId: 'g-a', isActive: false });
      expect((await signIn({ claims: { sub: 'g-a', email: 'a@example.com' } })).error).toBe('account_suspended');
      await mkUser({ email: 'b@example.com', isActive: false });
      expect((await signIn({ claims: { sub: 'g-b', email: 'b@example.com' } })).error).toBe('account_suspended');
      expect(await h.codes.count()).toBe(0);
      expect((await h.users.findOneBy({ email: 'b@example.com' }))?.googleId).toBeNull(); // not even linked
    });

    // ----- CSRF / state / cookie ---------------------------------------------------------------------
    it('rejects a callback with NO state cookie (login-CSRF: a victim following an attacker-made link)', async () => {
      const r = await signIn({ tamper: () => ({ cookie: 'unrelated=1' }) });
      expect(r.error).toBe('invalid_state');
      expect(googleReply.calls).toHaveLength(0); // we never even spent the code
      expect(await h.users.count()).toBe(0);
    });

    it('rejects a state that does not match the cookie', async () => {
      const r = await signIn({ tamper: () => ({ state: 'forged-state-value' }) });
      expect(r.error).toBe('invalid_state');
      expect(googleReply.calls).toHaveLength(0);
    });

    it("rejects a state taken from a different attempt (attacker's valid state + victim's cookie)", async () => {
      const other = await start();
      const r = await signIn({ tamper: () => ({ state: other.state }) });
      expect(r.error).toBe('invalid_state');
    });

    it('rejects a tampered cookie payload (e.g. editing the requested role) and a wrong signature', async () => {
      const r1 = await signIn({
        tamper: (f) => {
          const [body, sig] = f.cookie.split('=')[1].split('.');
          const p = JSON.parse(Buffer.from(body, 'base64url').toString());
          p.r = 'admin';
          return { cookie: `rf_google_oauth=${Buffer.from(JSON.stringify(p)).toString('base64url')}.${sig}` };
        },
      });
      expect(r1.error).toBe('invalid_state');
      const r2 = await signIn({ tamper: (f) => ({ cookie: f.cookie.slice(0, -3) + 'AAA' }) });
      expect(r2.error).toBe('invalid_state');
      expect(googleReply.calls).toHaveLength(0);
    });

    it('rejects an expired state cookie (older than 10 minutes)', async () => {
      const f = await start();
      const real = Date.now;
      jest.spyOn(Date, 'now').mockImplementation(() => real() + 11 * 60 * 1000);
      const cb = await fetch(`${h.base}/api/auth/google/callback?code=C&state=${f.state}`, { redirect: 'manual', headers: { Cookie: f.cookie } });
      expect(new URL(cb.headers.get('location')!).searchParams.get('googleError')).toBe('invalid_state');
      jest.restoreAllMocks();
    });

    it('rejects a missing/empty state or a cookie without a signature', async () => {
      expect((await signIn({ callbackQuery: 'code=C' })).error).toBe('invalid_state');
      expect((await signIn({ tamper: () => ({ state: '' }) })).error).toBe('invalid_state');
      expect((await signIn({ tamper: () => ({ cookie: 'rf_google_oauth=abc' }) })).error).toBe('invalid_state');
    });

    // ----- Google-side failures ----------------------------------------------------------------------
    it('reports access_denied when the user cancels on Google (after validating state)', async () => {
      const f = await start();
      const cb = await fetch(`${h.base}/api/auth/google/callback?error=access_denied&state=${f.state}`, { redirect: 'manual', headers: { Cookie: f.cookie } });
      expect(new URL(cb.headers.get('location')!).searchParams.get('googleError')).toBe('access_denied');
      expect(googleReply.calls).toHaveLength(0);
    });

    it('does not let an attacker forge access_denied with a bad state (invalid_state wins)', async () => {
      const f = await start();
      const cb = await fetch(`${h.base}/api/auth/google/callback?error=access_denied&state=nope`, { redirect: 'manual', headers: { Cookie: f.cookie } });
      expect(new URL(cb.headers.get('location')!).searchParams.get('googleError')).toBe('invalid_state');
    });

    it('requires a code when there is no error', async () => {
      const f = await start();
      const cb = await fetch(`${h.base}/api/auth/google/callback?state=${f.state}`, { redirect: 'manual', headers: { Cookie: f.cookie } });
      expect(new URL(cb.headers.get('location')!).searchParams.get('googleError')).toBe('exchange_failed');
    });

    it.each([
      ['Google rejects the code (replay / expired)', () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })],
      ['Google is down', () => new Response('<html>', { status: 502 })],
    ])('maps %s to exchange_failed and creates nothing', async (_l, reply) => {
      const r = await signIn({ reply });
      expect(r.error).toBe('exchange_failed');
      expect(await h.users.count()).toBe(0);
    });

    it('rejects an ID token for a different client, a replayed nonce, or an expired token', async () => {
      expect((await signIn({ claims: { aud: 'other-client' } })).error).toBe('exchange_failed');
      expect((await signIn({ claims: { nonce: 'replayed-from-another-flow' } })).error).toBe('exchange_failed');
      expect((await signIn({ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } })).error).toBe('exchange_failed');
      expect(await h.users.count()).toBe(0);
    });

    it('never leaks internal error text into the redirect', async () => {
      const r = await signIn({ reply: () => { throw new Error('connect ECONNREFUSED 10.0.0.5:443 secret'); } });
      expect(r.error).toBe('exchange_failed');
      expect(r.location).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|secret/);
    });

    // ----- concurrency -------------------------------------------------------------------------------
    it('five simultaneous first-time sign-ins for the same person create exactly one account', async () => {
      const flows = await Promise.all(Array.from({ length: 5 }, () => start()));
      googleReply.next = null;
      const original = tokenSpy.getMockImplementation()!;
      tokenSpy.mockImplementation(async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url ?? String(input);
        if (!url.startsWith('https://oauth2.googleapis.com/')) return original(input, init);
        // each callback carries its own verifier; look up which flow it belongs to via the nonce stored in its cookie
        const v = (init.body as URLSearchParams).get('code_verifier')!;
        const f = flows.find((x) => JSON.parse(Buffer.from(x.cookie.split('=')[1].split('.')[0], 'base64url').toString()).v === v)!;
        await new Promise((r) => setTimeout(r, 40));
        return new Response(JSON.stringify({ id_token: idToken(f.nonce) }), { status: 200 });
      });
      const results = await Promise.all(flows.map((f) => fetch(`${h.base}/api/auth/google/callback?code=C&state=${f.state}`, { redirect: 'manual', headers: { Cookie: f.cookie } })));
      for (const r of results) expect(r.headers.get('location')).toMatch(/\/auth\/google\/callback\?code=/);
      expect(await h.users.count()).toBe(1);
      expect(await h.profiles.count()).toBe(1);
      expect(await h.codes.count()).toBe(5); // one handoff code per browser
    });
  });

  // ===============================================================================================
  describe('POST /auth/google/exchange', () => {
    it('trades the one-time code for the same token pair a password login returns', async () => {
      const r = await signIn();
      const ex = await exchange(r.loginCode);
      expect(ex.status).toBe(200);
      expect(Object.keys(ex.body).sort()).toEqual(['accessToken', 'refreshToken', 'returnTo']);
      const u = (await h.users.findOneBy({ email: 'ana@example.com' }))!;
      expect(h.jwt.decode(ex.body.accessToken)).toMatchObject({ sub: u.id, email: 'ana@example.com', role: 'runner' });
      expect(JSON.stringify(ex.body)).not.toMatch(/password|passwordHash|googleId/i);
    });

    it('stores only a hash of the code, expiring in ~60 seconds', async () => {
      const r = await signIn();
      const [row] = await h.ds.query('SELECT * FROM oauth_login_codes');
      expect(row.code_hash).toBe(sha(r.loginCode));
      expect(JSON.stringify(row)).not.toContain(r.loginCode);
      const ttl = new Date(row.expires_at).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(50_000);
      expect(ttl).toBeLessThanOrEqual(61_000);
    });

    it('works exactly once', async () => {
      const r = await signIn();
      expect((await exchange(r.loginCode)).status).toBe(200);
      const again = await exchange(r.loginCode);
      expect(again.status).toBe(400);
      expect(again.body.error).toBe('GOOGLE_INVALID_CODE');
    });

    it('ten simultaneous exchanges of one code yield exactly one token pair', async () => {
      const r = await signIn();
      const all = await Promise.all(Array.from({ length: 10 }, () => exchange(r.loginCode)));
      expect(all.filter((x) => x.status === 200)).toHaveLength(1);
      expect(all.filter((x) => x.status === 400)).toHaveLength(9);
    });

    it('rejects an expired code', async () => {
      const r = await signIn();
      await h.ds.query('UPDATE oauth_login_codes SET expires_at = NOW() - INTERVAL 1 SECOND');
      expect((await exchange(r.loginCode)).status).toBe(400);
    });

    it.each([['short'], ['x'.repeat(42)], ['x'.repeat(44)], ['a'.repeat(42) + '!'], [''], [null], [12345], [{ a: 1 }], [['a']]])('rejects malformed code %p with 400', async (code) => {
      expect((await exchange(code)).status).toBe(400);
    });

    it('rejects an unknown but well-formed code', async () => {
      expect((await exchange('A'.repeat(43))).body.error).toBe('GOOGLE_INVALID_CODE');
    });

    it('rejects extra fields (forbidNonWhitelisted) and a missing body', async () => {
      const r = await signIn();
      const bad = await fetch(`${h.base}/api/auth/google/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: r.loginCode, userId: '1' }) });
      expect(bad.status).toBe(400);
      expect((await fetch(`${h.base}/api/auth/google/exchange`, { method: 'POST' })).status).toBe(400);
    });

    it('re-checks the account: a user suspended after the code was issued gets 403 and no tokens', async () => {
      const r = await signIn();
      await h.users.update({ email: 'ana@example.com' }, { isActive: false });
      const ex = await exchange(r.loginCode);
      expect(ex.status).toBe(403);
      expect(ex.body.error).toBe('GOOGLE_ACCOUNT_SUSPENDED');
      expect(ex.body.accessToken).toBeUndefined();
    });

    it('returns the validated return path from the original request, and null for anything unsafe', async () => {
      const ok = await signIn({ qs: `?redirect=${encodeURIComponent('/events/9/register?ref=x')}` });
      expect((await exchange(ok.loginCode)).body.returnTo).toBe('/events/9/register?ref=x');
      await h.ds.query('TRUNCATE TABLE oauth_login_codes');
      for (const evil of ['https://evil.example', '//evil.example', '/login', '/runner/../admin']) {
        const r = await signIn({ qs: `?redirect=${encodeURIComponent(evil)}`, claims: { sub: 'g-' + evil.length, email: `u${evil.length}@example.com` } });
        expect((await exchange(r.loginCode)).body.returnTo).toBeNull();
      }
    });

    it('a code for one user can never yield tokens for another', async () => {
      const a = await signIn({ claims: { sub: 'g-a', email: 'a@example.com' } });
      const b = await signIn({ claims: { sub: 'g-b', email: 'b@example.com' } });
      const ta = h.jwt.decode((await exchange(a.loginCode)).body.accessToken) as any;
      const tb = h.jwt.decode((await exchange(b.loginCode)).body.accessToken) as any;
      expect(ta.email).toBe('a@example.com');
      expect(tb.email).toBe('b@example.com');
    });
  });

  describe('old insecure endpoint', () => {
    it('this controller exposes no POST /auth/google that trusts a client-supplied email', async () => {
      const res = await fetch(`${h.base}/api/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleId: 'x', email: 'victim@example.com' }) });
      expect(res.status).toBe(404);
    });
  });
});
