import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import { AuthService } from '../auth.service';
import { User } from '../../users/entities/user.entity';
import { RunnerProfile } from '../../users/entities/runner-profile.entity';
import { UserRole } from '../../common/enums';
import { OauthLoginCode } from './entities/oauth-login-code.entity';
import { GoogleAuthConfig } from './google.config';
import { GoogleOAuthClient, GoogleProfile, b64url } from './google-oauth.client';
import { GoogleLoginError, LOGIN_CODE_TTL_MS, SELF_SERVE_ROLES, STATE_TTL_MS } from './google.constants';

interface StatePayload {
  s: string; // state
  v: string; // PKCE verifier
  n: string; // nonce
  r: string | null; // requested role (only honoured for brand-new accounts)
  t: string | null; // validated return path
  e: number; // expiry (ms epoch)
}

const CODE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
// A same-site relative path (+ optional query). No scheme/host, no `//`, no backslash, no `..`.
const RETURN_TO = /^\/(?!\/)[A-Za-z0-9_\-./~%]*(\?[A-Za-z0-9_\-.~%=&+]*)?$/;
const NEVER_RETURN_TO = /^\/(login|register|auth\/google)(\/|\?|$)/;

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function sanitizeReturnTo(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 255) return null;
  if (!RETURN_TO.test(v) || v.split('?')[0].split('/').includes('..') || NEVER_RETURN_TO.test(v)) return null;
  return v;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly cfg: GoogleAuthConfig,
    private readonly client: GoogleOAuthClient,
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(OauthLoginCode) private readonly codes: Repository<OauthLoginCode>,
    private readonly auth: AuthService,
  ) {}

  // ---- state cookie (browser-bound CSRF protection) ----------------------------------------

  private sign(payload: StatePayload): string {
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    return `${body}.${b64url(createHmac('sha256', this.cfg.stateKey).update(body).digest())}`;
  }

  /** Returns the payload only if the signature is valid and it has not expired. */
  private verifyCookie(header: string | undefined): StatePayload | null {
    const raw = (header ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('rf_google_oauth='))
      ?.slice('rf_google_oauth='.length);
    if (!raw) return null;
    const [body, sig] = raw.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.cfg.stateKey).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
      return typeof p.e === 'number' && p.e > Date.now() && typeof p.s === 'string' && typeof p.v === 'string' && typeof p.n === 'string' ? p : null;
    } catch {
      return null;
    }
  }

  /** Step 1: build Google's URL plus the signed cookie that binds this attempt to this browser. */
  begin(role?: string, redirect?: string): { url: string; cookie: string } {
    if (!this.cfg.enabled) throw new GoogleLoginError('not_configured');
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const { verifier, challenge } = this.client.newPkce();
    const safeRole = role && (SELF_SERVE_ROLES as readonly string[]).includes(role) ? role : null;
    const cookie = this.sign({ s: state, v: verifier, n: nonce, r: safeRole, t: sanitizeReturnTo(redirect), e: Date.now() + STATE_TTL_MS });
    return { url: this.client.buildAuthUrl({ state, nonce, challenge }), cookie };
  }

  // ---- callback -----------------------------------------------------------------------------

  /** Step 2: validates everything, signs the user in server-side and returns the frontend URL to send them to. */
  async complete(query: { code?: unknown; state?: unknown; error?: unknown }, cookieHeader: string | undefined): Promise<string> {
    if (!this.cfg.enabled) throw new GoogleLoginError('not_configured');

    const payload = this.verifyCookie(cookieHeader);
    const state = typeof query.state === 'string' ? query.state : '';
    const a = Buffer.from(state);
    const b = Buffer.from(payload?.s ?? '');
    if (!payload || a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) throw new GoogleLoginError('invalid_state');

    if (typeof query.error === 'string' && query.error) {
      throw new GoogleLoginError(query.error === 'access_denied' ? 'access_denied' : 'exchange_failed');
    }
    if (typeof query.code !== 'string' || !query.code || query.code.length > 2048) throw new GoogleLoginError('exchange_failed');

    const profile = await this.client.exchange(query.code, payload.v, payload.n);
    const user = await this.resolveUser(profile, payload.r);
    const code = await this.issueLoginCode(user.id, payload.t);
    return `${this.cfg.frontendUrl}/auth/google/callback?code=${code}`;
  }

  // ---- account resolution -------------------------------------------------------------------

  private async resolveUser(profile: GoogleProfile, requestedRole: string | null): Promise<User> {
    try {
      return await this.ds.transaction((m) => this.resolveInTx(m, profile, requestedRole));
    } catch (err: any) {
      if (err?.code !== 'ER_DUP_ENTRY') throw err;
      // Two first-time callbacks raced to create the same account: the loser just finds it.
      return this.ds.transaction((m) => this.resolveInTx(m, profile, requestedRole));
    }
  }

  private async resolveInTx(m: EntityManager, p: GoogleProfile, requestedRole: string | null): Promise<User> {
    const users = m.getRepository(User);
    let user = await users.findOne({ where: { googleId: p.googleId } });

    if (!user) {
      user = await users.findOne({ where: { email: p.email } });
      if (user) {
        // Google has verified this address, and `email_verified` was enforced upstream.
        if (user.googleId && user.googleId !== p.googleId) throw new GoogleLoginError('account_conflict');
        if (!user.isActive) throw new GoogleLoginError('account_suspended');
        user.googleId = p.googleId;
        // A guest-checkout shadow account (random password) is claimed by whoever proves the email.
        if (user.isGuest) user.isGuest = false;
        await users.save(user);
      } else {
        // The role comes from the browser, so it is limited to the self-serve roles and only
        // applies here, to a brand-new account. Existing users' roles are never changed.
        const role = requestedRole === 'organizer' ? UserRole.ORGANIZER : UserRole.RUNNER;
        user = await users.save(users.create({ email: p.email, googleId: p.googleId, role }));
      }
    }
    if (!user.isActive) throw new GoogleLoginError('account_suspended');

    const profiles = m.getRepository(RunnerProfile);
    if (!(await profiles.findOne({ where: { userId: user.id } }))) {
      await profiles.save(
        profiles.create({ userId: user.id, firstName: p.firstName ?? p.email.split('@')[0].slice(0, 100), lastName: p.lastName ?? '' }),
      );
    }
    return user;
  }

  // ---- one-time hand-off to the Nuxt app ----------------------------------------------------

  private async issueLoginCode(userId: string, returnTo: string | null): Promise<string> {
    await this.codes.delete({ expiresAt: LessThan(new Date(Date.now() - 24 * 3600 * 1000)) }); // keeps the table tiny
    const code = b64url(randomBytes(32));
    await this.codes.save(
      this.codes.create({ codeHash: sha256hex(code), userId, returnTo, expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS), consumedAt: null }),
    );
    return code;
  }

  /** Step 3: the Nuxt callback page trades the code for the same tokens a password login returns. */
  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; returnTo: string | null }> {
    const invalid = () => new BadRequestException({ statusCode: 400, message: 'This sign-in link is invalid or has expired. Please try again.', error: 'GOOGLE_INVALID_CODE' });
    if (!CODE_FORMAT.test(code)) throw invalid();

    const hash = sha256hex(code);
    // Atomic single use: exactly one caller can flip consumed_at from NULL.
    const res = await this.codes
      .createQueryBuilder()
      .update(OauthLoginCode)
      .set({ consumedAt: new Date() })
      .where('code_hash = :hash AND consumed_at IS NULL AND expires_at > :now', { hash, now: new Date() })
      .execute();
    if (res.affected !== 1) throw invalid();

    const row = await this.codes.findOneOrFail({ where: { codeHash: hash } });
    const user = await this.users.findOne({ where: { id: row.userId } });
    if (!user || !user.isActive) {
      throw new ForbiddenException({ statusCode: 403, message: 'This account is suspended.', error: 'GOOGLE_ACCOUNT_SUSPENDED' });
    }
    const tokens = await this.auth.issueTokens(user);
    return { ...tokens, returnTo: sanitizeReturnTo(row.returnTo) };
  }
}
