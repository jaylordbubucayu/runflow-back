// AuthService (imported transitively) pulls in bcrypt's native binary, which these tests never use.
jest.mock('bcrypt', () => ({}));

import { GoogleAuthConfig } from './google.config';
import { GoogleOAuthClient, sha256b64url, validateIdToken } from './google-oauth.client';
import { sanitizeReturnTo } from './google-auth.service';
import { ConfigService } from '@nestjs/config';

const CID = '1234.apps.googleusercontent.com';
const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = 1_800_000_000_000;
const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com', aud: CID, azp: CID, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 5, nonce: 'N0NCE',
  sub: '110169484474386276334', email: 'Ana.Reyes@Example.com', email_verified: true, given_name: 'Ana', family_name: 'Reyes', ...over,
});
const token = (c: unknown) => `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(c)}.signature`;
const check = (c: unknown, over: Partial<{ nonce: string; clientId: string }> = {}) =>
  validateIdToken(token(c), { clientId: CID, nonce: 'N0NCE', now: NOW, ...over });
const code = (fn: () => unknown) => { try { fn(); return null; } catch (e: any) { return e.code ?? 'threw'; } };

describe('validateIdToken', () => {
  it('accepts a good token, lower-casing the email and trimming names', () => {
    expect(check(claims({ given_name: '  Ana ' }))).toEqual({ googleId: '110169484474386276334', email: 'ana.reyes@example.com', firstName: 'Ana', lastName: 'Reyes' });
  });
  it('accepts both Google issuer spellings and an audience array whose azp is us', () => {
    expect(code(() => check(claims({ iss: 'accounts.google.com' })))).toBeNull();
    expect(code(() => check(claims({ aud: [CID, 'other'], azp: CID })))).toBeNull();
  });
  it('tolerates small clock skew but not an expired token', () => {
    expect(code(() => check(claims({ exp: NOW / 1000 - 30 })))).toBeNull();
    expect(code(() => check(claims({ exp: NOW / 1000 - 120 })))).toBe('exchange_failed');
  });
  it.each([
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['wrong audience', { aud: 'someone-elses-client' }],
    ['audience array without matching azp', { aud: [CID, 'x'], azp: 'x' }],
    ['issued in the future', { iat: NOW / 1000 + 600 }],
    ['nonce mismatch (replayed token)', { nonce: 'other' }],
    ['missing nonce', { nonce: undefined }],
    ['missing sub', { sub: '' }],
    ['non-string sub', { sub: 12345 }],
    ['missing email', { email: undefined }],
    ['malformed email', { email: 'not-an-email' }],
    ['missing exp', { exp: undefined }],
  ])('rejects %s', (_l, over) => {
    expect(code(() => check(claims(over)))).toBe('exchange_failed');
  });
  it.each([[false], ['true'], [undefined], [1]])('reports email_unverified unless email_verified is exactly true (%p)', (v) => {
    expect(code(() => check(claims({ email_verified: v })))).toBe('email_unverified');
  });
  it.each([[undefined], [null], [123], [''], ['a.b'], ['a.b.c.d'], [`x.${Buffer.from('not json').toString('base64url')}.y`], [`x.${seg('str')}.y`], [`x.${seg(null)}.y`]])('rejects malformed id_token %p', (t) => {
    expect(code(() => validateIdToken(t, { clientId: CID, nonce: 'N0NCE', now: NOW }))).toBe('exchange_failed');
  });
  it('falls back to null names rather than inventing them', () => {
    expect(check(claims({ given_name: undefined, family_name: '' }))).toMatchObject({ firstName: null, lastName: null });
  });
});

const cfgFrom = (env: Record<string, string | undefined>) => new GoogleAuthConfig({ get: (k: string) => env[k] } as unknown as ConfigService);
const good = {
  GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_CALLBACK_URL: 'https://api.example.com/api/auth/google/callback',
  FRONTEND_URL: 'https://app.example.com/', JWT_ACCESS_SECRET: 'a'.repeat(32),
};

describe('GoogleAuthConfig', () => {
  it('is simply off when no Google values are set (the feature is optional)', () => {
    expect(cfgFrom({ FRONTEND_URL: 'x' }).enabled).toBe(false);
  });
  it('is enabled and normalised when complete', () => {
    const c = cfgFrom(good);
    expect(c.enabled).toBe(true);
    expect(c.frontendUrl).toBe('https://app.example.com');
    expect(c.secureCookies).toBe(false);
    expect(c.stateKey).toHaveLength(32);
    expect(c.stateKey.toString()).not.toContain(good.JWT_ACCESS_SECRET); // derived, not the JWT secret itself
  });
  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL'])('a PARTIAL setup (missing %s) fails the boot with a precise message', (k) => {
    expect(() => cfgFrom({ ...good, [k]: undefined })).toThrow(new RegExp(`${k} is required`));
  });
  it('rejects bad callback URLs, short secrets and a missing frontend URL', () => {
    expect(() => cfgFrom({ ...good, GOOGLE_CALLBACK_URL: 'ftp://x/auth/google/callback' })).toThrow(/absolute http/);
    expect(() => cfgFrom({ ...good, GOOGLE_CALLBACK_URL: 'https://api.example.com/api/login' })).toThrow(/must end with/);
    expect(() => cfgFrom({ ...good, JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 16/);
    expect(() => cfgFrom({ ...good, FRONTEND_URL: '' })).toThrow(/FRONTEND_URL is required/);
  });
  it('requires https in production and marks cookies Secure', () => {
    expect(() => cfgFrom({ ...good, NODE_ENV: 'production', GOOGLE_CALLBACK_URL: 'http://api.example.com/api/auth/google/callback' })).toThrow(/https in production/);
    expect(cfgFrom({ ...good, NODE_ENV: 'production' }).secureCookies).toBe(true);
  });
  it('never echoes secret values in errors', () => {
    expect.assertions(2);
    try { cfgFrom({ ...good, GOOGLE_CLIENT_SECRET: 'TOP-SECRET-xyz', JWT_ACCESS_SECRET: 'tiny-secret' }); } catch (e) {
      expect((e as Error).message).not.toContain('TOP-SECRET-xyz');
      expect((e as Error).message).not.toContain('tiny-secret');
    }
  });
});

describe('GoogleOAuthClient', () => {
  const client = new GoogleOAuthClient(cfgFrom(good));
  afterEach(() => jest.restoreAllMocks());

  it('builds an authorization-code + PKCE(S256) URL and never includes the client secret', () => {
    const { verifier, challenge } = client.newPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).toBe(sha256b64url(verifier));
    const u = new URL(client.buildAuthUrl({ state: 'st', nonce: 'no', challenge }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    expect(p.get('client_id')).toBe(CID);
    expect(p.get('redirect_uri')).toBe(good.GOOGLE_CALLBACK_URL);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBe(challenge);
    expect(p.get('state')).toBe('st');
    expect(p.get('nonce')).toBe('no');
    expect(p.get('prompt')).toBe('select_account');
    expect(u.toString()).not.toContain('sec');
  });

  it('generates a fresh verifier every time', () => {
    expect(client.newPkce().verifier).not.toBe(client.newPkce().verifier);
  });

  it('exchanges the code server-side with the verifier and secret, then validates the ID token', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id_token: token(claims({ exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000 })) }), { status: 200 }));
    const profile = await client.exchange('AUTHCODE', 'VERIFIER', 'N0NCE');
    expect(profile.email).toBe('ana.reyes@example.com');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      code: 'AUTHCODE', client_id: CID, client_secret: 'sec', redirect_uri: good.GOOGLE_CALLBACK_URL, grant_type: 'authorization_code', code_verifier: 'VERIFIER',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['Google rejects the code', () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })],
    ['Google is down', () => new Response('<html>', { status: 503 })],
    ['a non-JSON body', () => new Response('nope', { status: 200 })],
    ['no id_token', () => new Response('{}', { status: 200 })],
  ])('maps %s to exchange_failed', async (_l, make) => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(make()));
    await expect(client.exchange('c', 'v', 'n')).rejects.toMatchObject({ code: 'exchange_failed' });
  });

  it('maps timeouts and network errors to exchange_failed (and never leaks them)', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT secret-host'), { name: 'TimeoutError' }));
    await expect(client.exchange('c', 'v', 'n')).rejects.toMatchObject({ code: 'exchange_failed', message: 'exchange_failed' });
  });
});

describe('sanitizeReturnTo (open-redirect guard)', () => {
  it.each([
    ['/runner', '/runner'], ['/runner/registrations/12', '/runner/registrations/12'], ['/events/9/register?ref=a%20b&x=1', '/events/9/register?ref=a%20b&x=1'],
    ['/become-organizer', '/become-organizer'],
  ])('keeps %s', (v, out) => expect(sanitizeReturnTo(v)).toBe(out));
  it.each([
    'https://evil.example', '//evil.example', '/\\evil.example', '///evil', 'javascript:alert(1)', 'runner', '', '/runner/../admin', '/a/%2e%2e/b/../c',
    '/login', '/login?redirect=/x', '/register', '/auth/google/callback', '/runner\n', '/runner<script>', `/${'a'.repeat(300)}`, null, undefined, 42, {},
  ])('drops %p', (v) => expect(sanitizeReturnTo(v as any)).toBeNull());
});
