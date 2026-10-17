import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { StravaConfig } from './strava.config';
import { StravaConnection } from './entities/strava-connection.entity';
import { StravaOauthState } from './entities/strava-oauth-state.entity';
import { StravaCryptoService } from './strava-crypto.service';
import { StravaHttpClient, StravaTokenResponse } from './strava-http.client';
import { StravaApiError, mapStravaError, stravaError } from './strava.errors';
import { REQUIRED_SCOPE, StravaErrorCode } from './strava.constants';
import { StravaCallbackDto } from './dto/strava.dto';

const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RETURN_TO = '/runner/strava';
// Only app-internal runner paths. Anything else (absolute URLs, //host, backslashes, ..) is dropped.
const RETURN_TO_PATTERN = /^\/runner(\/[A-Za-z0-9_\-]+)*\/?$/;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function sanitizeReturnTo(value?: string | null): string {
  return value && value.length <= 255 && RETURN_TO_PATTERN.test(value) ? value : DEFAULT_RETURN_TO;
}

export function parseScopes(raw?: string | null): string[] {
  return (raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

export interface StravaStatus {
  configured: boolean;
  connected: boolean;
  canPublish: boolean;
  athleteId: string | null;
  athleteName: string | null;
  profileUrl: string | null;
  scopes: string[];
  /** Why a previously-connected account is no longer connected, if applicable. */
  disconnectReason: string | null;
}

@Injectable()
export class StravaAuthService {
  private readonly logger = new Logger(StravaAuthService.name);

  constructor(
    private readonly cfg: StravaConfig,
    @InjectRepository(StravaConnection) private readonly connections: Repository<StravaConnection>,
    @InjectRepository(StravaOauthState) private readonly states: Repository<StravaOauthState>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly client: StravaHttpClient,
    private readonly crypto: StravaCryptoService,
  ) {}

  toStatus(conn: StravaConnection | null): StravaStatus {
    const scopes = parseScopes(conn?.scopes);
    const connected = !!conn?.isConnected;
    return {
      configured: this.cfg.enabled,
      connected,
      canPublish: connected && scopes.includes(REQUIRED_SCOPE),
      athleteId: connected ? conn!.stravaAthleteId : null,
      athleteName: connected ? conn!.athleteDisplayName : null,
      profileUrl: connected && conn!.stravaAthleteId ? `https://www.strava.com/athletes/${conn!.stravaAthleteId}` : null,
      scopes: connected ? scopes : [],
      disconnectReason: connected ? null : conn?.disconnectReason ?? null,
    };
  }

  async getStatus(userId: string): Promise<StravaStatus> {
    return this.toStatus(await this.connections.findOne({ where: { userId } }));
  }

  /** Step 1: create a single-use state bound to this user and return Strava's authorize URL. */
  async start(userId: string, returnTo?: string): Promise<{ authorizeUrl: string }> {
    // Opportunistic cleanup keeps the table tiny without needing a scheduler.
    await this.states.delete({ expiresAt: LessThan(new Date(Date.now() - 24 * 3600 * 1000)) });

    const state = randomBytes(32).toString('base64url');
    await this.states.save(
      this.states.create({
        stateHash: sha256(state),
        userId,
        returnTo: sanitizeReturnTo(returnTo),
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
        consumedAt: null,
      }),
    );

    const url = new URL(this.cfg.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: REQUIRED_SCOPE,
      state,
    }).toString();
    return { authorizeUrl: url.toString() };
  }

  /** Atomically consume the state for THIS user. Exactly one caller can ever win. */
  private async consumeState(userId: string, state: string): Promise<string> {
    const hash = sha256(state);
    const res = await this.states
      .createQueryBuilder()
      .update(StravaOauthState)
      .set({ consumedAt: new Date() })
      .where('state_hash = :hash AND user_id = :userId AND consumed_at IS NULL AND expires_at > :now', {
        hash, userId, now: new Date(),
      })
      .execute();
    if (res.affected !== 1) {
      throw stravaError(HttpStatus.BAD_REQUEST, StravaErrorCode.INVALID_STATE, 'This Strava authorization link is invalid or has expired. Please start again.');
    }
    const row = await this.states.findOne({ where: { stateHash: hash } });
    return sanitizeReturnTo(row?.returnTo);
  }

  /** Step 2: called by the Nuxt callback page (authenticated) with what Strava put in the URL. */
  async complete(userId: string, dto: StravaCallbackDto): Promise<{ returnTo: string; status: StravaStatus }> {
    if (dto.error) {
      await this.consumeState(userId, dto.state).catch(() => undefined);
      throw stravaError(
        HttpStatus.BAD_REQUEST,
        dto.error === 'access_denied' ? StravaErrorCode.ACCESS_DENIED : StravaErrorCode.UPSTREAM,
        dto.error === 'access_denied' ? 'Strava access was not granted. You can try connecting again any time.' : 'Strava reported an error during authorization.',
      );
    }
    if (!dto.code) {
      throw stravaError(HttpStatus.BAD_REQUEST, StravaErrorCode.INVALID_STATE, 'The Strava authorization response was incomplete. Please start again.');
    }

    const returnTo = await this.consumeState(userId, dto.state);

    let token: StravaTokenResponse;
    try {
      token = await this.client.exchangeCode(dto.code);
    } catch (err) {
      if (err instanceof StravaApiError && err.kind === 'http' && err.status === 400) {
        throw stravaError(HttpStatus.BAD_REQUEST, StravaErrorCode.INVALID_STATE, 'Strava did not accept that authorization (it may have expired). Please start again.');
      }
      throw mapStravaError(err);
    }

    const athleteId = token.athlete?.id != null ? String(token.athlete.id) : null;
    if (!athleteId || !token.access_token || !token.refresh_token) {
      throw stravaError(HttpStatus.BAD_GATEWAY, StravaErrorCode.UPSTREAM, 'Strava returned an incomplete response.');
    }

    // The athlete can untick scopes on Strava's consent screen, so never assume what we asked for.
    const granted = parseScopes(token.scope ?? dto.scope);
    if (!granted.includes(REQUIRED_SCOPE)) {
      // Clean up the useless grant — unless this Strava account is already linked to a RunFlow
      // account: revoking would invalidate THAT connection's tokens too.
      const linked = await this.connections.findOne({ where: { stravaAthleteId: athleteId, isConnected: true } });
      if (!linked) await this.client.revoke(token.refresh_token).catch(() => undefined);
      throw stravaError(HttpStatus.BAD_REQUEST, StravaErrorCode.MISSING_SCOPE, 'RunFlow needs permission to upload activities to Strava. Please connect again and keep "Upload your activities to Strava" checked.');
    }

    const name = [token.athlete?.firstname, token.athlete?.lastname].filter(Boolean).join(' ').trim() || token.athlete?.username || null;

    try {
      await this.dataSource.transaction(async (m) => {
        const other = await m.findOne(StravaConnection, { where: { stravaAthleteId: athleteId, isConnected: true } });
        if (other && other.userId !== userId) throw new AthleteLinkedError();

        const existing = await m.findOne(StravaConnection, { where: { userId }, lock: { mode: 'pessimistic_write' } });
        const row = existing ?? m.create(StravaConnection, { userId });
        row.stravaAthleteId = athleteId;
        row.athleteDisplayName = name ? name.slice(0, 120) : null;
        row.accessTokenEncrypted = this.crypto.encrypt(token.access_token, userId);
        row.refreshTokenEncrypted = this.crypto.encrypt(token.refresh_token, userId);
        row.expiresAt = new Date(token.expires_at * 1000);
        row.scopes = granted.join(' ');
        row.isConnected = true;
        row.disconnectReason = null;
        row.disconnectedAt = null;
        await m.save(row);
      });
    } catch (err: any) {
      // Deliberately no revoke here: tokens belong to the same athlete+app as the other account's.
      if (err instanceof AthleteLinkedError || err?.code === 'ER_DUP_ENTRY') {
        throw stravaError(HttpStatus.CONFLICT, StravaErrorCode.ATHLETE_LINKED, 'This Strava account is already connected to a different RunFlow account.');
      }
      throw err;
    }

    return { returnTo, status: await this.getStatus(userId) };
  }

  /** Revoke at Strava (best effort) and wipe local credentials. Idempotent. */
  async disconnect(userId: string): Promise<{ disconnected: true; revokedAtStrava: boolean }> {
    const conn = await this.connections.findOne({ where: { userId } });
    if (!conn || !conn.isConnected) return { disconnected: true, revokedAtStrava: false };

    let revoked = false;
    try {
      if (conn.refreshTokenEncrypted) {
        await this.client.revoke(this.crypto.decrypt(conn.refreshTokenEncrypted, conn.userId));
        revoked = true;
      }
    } catch (err) {
      // Never log the token; the status/kind is enough to debug.
      this.logger.warn(`Strava revoke failed for user ${userId}: ${(err as Error).message}`);
    }
    await this.connections.update(conn.id, {
      isConnected: false, accessTokenEncrypted: null, refreshTokenEncrypted: null, expiresAt: null,
      stravaAthleteId: null, athleteDisplayName: null, scopes: '', disconnectReason: 'user', disconnectedAt: new Date(),
    });
    return { disconnected: true, revokedAtStrava: revoked };
  }
}

class AthleteLinkedError extends Error {}
