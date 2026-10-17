import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { StravaConnection } from './entities/strava-connection.entity';
import { StravaCryptoService } from './strava-crypto.service';
import { StravaHttpClient } from './strava-http.client';
import { StravaApiError, mapStravaError, stravaError } from './strava.errors';
import { StravaErrorCode } from './strava.constants';

/** Refresh when fewer than this many ms remain. (Strava returns the same token if >1h remains.) */
const REFRESH_SKEW_MS = 10 * 60 * 1000;

@Injectable()
export class StravaTokenService {
  private readonly logger = new Logger(StravaTokenService.name);

  constructor(
    @InjectRepository(StravaConnection) private readonly repo: Repository<StravaConnection>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly client: StravaHttpClient,
    private readonly crypto: StravaCryptoService,
  ) {}

  notConnected() {
    return stravaError(HttpStatus.CONFLICT, StravaErrorCode.NOT_CONNECTED, 'Connect your Strava account first.');
  }

  async getActiveConnection(userId: string): Promise<StravaConnection> {
    const conn = await this.repo.findOne({ where: { userId } });
    if (!conn || !conn.isConnected) throw this.notConnected();
    return conn;
  }

  async markDisconnected(connectionId: string, reason: 'revoked' | 'insufficient_scope' | 'user') {
    await this.repo.update(connectionId, {
      isConnected: false,
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      stravaAthleteId: null,
      athleteDisplayName: null,
      scopes: '',
      disconnectReason: reason,
      disconnectedAt: new Date(),
    });
  }

  /** Returns a valid access token, refreshing (under a row lock) when it is near expiry. */
  async getAccessToken(userId: string): Promise<string> {
    const conn = await this.getActiveConnection(userId);
    if (conn.accessTokenEncrypted && conn.expiresAt && conn.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
      return this.crypto.decrypt(conn.accessTokenEncrypted, conn.userId);
    }
    return this.refresh(userId, null);
  }

  /**
   * Serialises refreshes per connection with SELECT ... FOR UPDATE. Strava rotates refresh
   * tokens, so two concurrent refreshes would otherwise race and one would persist a dead token.
   * @param staleToken the access token a caller just got a 401 for; if the stored token already
   *        differs, someone else refreshed while we waited and we reuse theirs.
   */
  private async refresh(userId: string, staleToken: string | null): Promise<string> {
    type Outcome = { token: string } | { revoked: true } | { error: unknown };
    const outcome: Outcome = await this.dataSource.transaction(async (m) => {
      const conn = await m.findOne(StravaConnection, { where: { userId }, lock: { mode: 'pessimistic_write' } });
      if (!conn || !conn.isConnected || !conn.refreshTokenEncrypted) return { revoked: true } as Outcome;

      const current = conn.accessTokenEncrypted ? this.crypto.decrypt(conn.accessTokenEncrypted, conn.userId) : null;
      const stillFresh = conn.expiresAt && conn.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS;
      if (current && ((!staleToken && stillFresh) || (staleToken && current !== staleToken))) {
        return { token: current };
      }

      try {
        const t = await this.client.refresh(this.crypto.decrypt(conn.refreshTokenEncrypted, conn.userId));
        conn.accessTokenEncrypted = this.crypto.encrypt(t.access_token, conn.userId);
        if (t.refresh_token) conn.refreshTokenEncrypted = this.crypto.encrypt(t.refresh_token, conn.userId);
        conn.expiresAt = new Date(t.expires_at * 1000);
        await m.save(conn);
        return { token: t.access_token };
      } catch (err) {
        if (err instanceof StravaApiError && err.kind === 'http' && (err.status === 400 || err.status === 401)) {
          // Refresh token rejected: the athlete revoked RunFlow (or the grant is gone).
          await m.update(StravaConnection, conn.id, {
            isConnected: false, accessTokenEncrypted: null, refreshTokenEncrypted: null, expiresAt: null,
            stravaAthleteId: null, athleteDisplayName: null, scopes: '', disconnectReason: 'revoked', disconnectedAt: new Date(),
          });
          return { revoked: true } as Outcome;
        }
        return { error: err } as Outcome; // transient: keep the connection untouched
      }
    });

    if ('token' in outcome) return outcome.token;
    if ('revoked' in outcome) {
      throw stravaError(HttpStatus.CONFLICT, StravaErrorCode.REVOKED, 'Strava access was revoked or expired. Please reconnect Strava.');
    }
    this.logger.warn(`Strava token refresh failed for user ${userId}: ${(outcome.error as Error)?.message}`);
    throw mapStravaError(outcome.error);
  }

  /**
   * Runs `fn` with a valid token. A 401 means the call was rejected before doing anything, so
   * retrying exactly once with a freshly refreshed token is safe even for creates. A 403 means
   * the grant lacks activity:write: the connection is flagged so the UI asks for a reconnect.
   */
  async withToken<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken(userId);
    try {
      return await fn(token);
    } catch (err) {
      if (err instanceof StravaApiError && err.kind === 'http' && err.status === 401) {
        const fresh = await this.refresh(userId, token);
        return fn(fresh);
      }
      if (err instanceof StravaApiError && err.kind === 'http' && err.status === 403) {
        const conn = await this.repo.findOne({ where: { userId } });
        if (conn) await this.markDisconnected(conn.id, 'insufficient_scope');
      }
      throw err;
    }
  }
}
