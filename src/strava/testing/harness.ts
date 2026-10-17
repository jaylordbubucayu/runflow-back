import { INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { MulterModule } from '@nestjs/platform-express';
import { getQueueToken } from '@nestjs/bullmq';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { memoryStorage } from 'multer';
import { sign } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../data-source';
import { StravaConnection } from '../entities/strava-connection.entity';
import { StravaActivity } from '../entities/strava-activity.entity';
import { StravaOauthState } from '../entities/strava-oauth-state.entity';
import { Registration } from '../../registrations/entities/registration.entity';
import { StravaConfig } from '../strava.config';
import { StravaCryptoService } from '../strava-crypto.service';
import { StravaHttpClient } from '../strava-http.client';
import { StravaTokenService } from '../strava-token.service';
import { StravaAuthService } from '../strava-auth.service';
import { StravaActivityService } from '../strava-activity.service';
import { StravaRateLimitGuard } from '../strava-rate-limit.guard';
import { StravaController } from '../strava.controller';
import { STRAVA_UPLOAD_QUEUE } from '../strava.constants';
import { localDateInZone } from '../strava-dates';

/**
 * Database-backed test harness. It refuses to touch any database whose name does not end in
 * `_test`, because it TRUNCATEs users/events/registrations between tests.
 *
 *   STRAVA_TEST_DB_HOST / _PORT / _USER / _PASSWORD / _NAME   (run `npm run migration:run` on it first)
 */
export const dbConfigured = () => !!process.env.STRAVA_TEST_DB_NAME;
export const JWT_SECRET = 'test-secret';
export const TZ = 'Asia/Manila';

export const TEST_ENV: Record<string, string> = {
  STRAVA_CLIENT_ID: '99999',
  STRAVA_CLIENT_SECRET: 'test-client-secret',
  STRAVA_REDIRECT_URI: 'https://app.test/runner/strava/callback',
  STRAVA_TOKEN_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789abcdef',
  FRONTEND_URL: 'https://app.test',
  STRAVA_UPLOAD_MAX_BYTES: '4096',
  STRAVA_EVENT_TIMEZONE: TZ,
};

@Injectable()
class TestJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: JWT_SECRET });
  }
  validate(p: { sub: string }) {
    return { id: p.sub, role: 'runner', email: `u${p.sub}@test` };
  }
}

export const today = () => localDateInZone(new Date(), TZ);
export const daysFromToday = (n: number) => localDateInZone(new Date(Date.now() + n * 86_400_000), TZ);

export function makeClientStub() {
  return {
    exchangeCode: jest.fn(),
    refresh: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
    createActivity: jest.fn(),
    createUpload: jest.fn(),
    getUpload: jest.fn(),
  };
}

export async function buildHarness(envOverrides: Record<string, string> = {}) {
  if (!dbConfigured()) throw new Error('STRAVA_TEST_DB_NAME is not set');
  const dbName = process.env.STRAVA_TEST_DB_NAME!;
  if (!/_test$/.test(dbName)) throw new Error(`Refusing to run destructive tests on database "${dbName}" (name must end in _test)`);

  const env = { ...TEST_ENV, ...envOverrides };
  // ConfigService prefers process.env over `load`ed values, and importing data-source.ts runs
  // dotenv against the project's real .env, so pin every Strava-related key explicitly.
  for (const k of ['STRAVA_ENABLED', 'STRAVA_TOKEN_ENCRYPTION_KEY_PREVIOUS', 'STRAVA_ACTIVITY_DATE_TOLERANCE_DAYS']) delete process.env[k];
  Object.assign(process.env, env);
  const client = makeClientStub();
  const queue = { add: jest.fn().mockResolvedValue({}) };

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
      TypeOrmModule.forRoot({
        ...dataSourceOptions,
        host: process.env.STRAVA_TEST_DB_HOST ?? '127.0.0.1',
        port: Number(process.env.STRAVA_TEST_DB_PORT ?? 3306),
        username: process.env.STRAVA_TEST_DB_USER,
        password: process.env.STRAVA_TEST_DB_PASSWORD,
        database: dbName,
        logging: false,
        retryAttempts: 0,
      } as any),
      TypeOrmModule.forFeature([StravaConnection, StravaActivity, StravaOauthState, Registration]),
      PassportModule,
      MulterModule.registerAsync({
        inject: [ConfigService],
        useFactory: (c: ConfigService) => ({
          storage: memoryStorage(),
          limits: { fileSize: Number(c.get('STRAVA_UPLOAD_MAX_BYTES')), files: 1, fields: 10, fieldSize: 4096 },
        }),
      }),
    ],
    controllers: [StravaController],
    providers: [
      StravaConfig, StravaCryptoService, StravaTokenService, StravaAuthService, StravaActivityService, StravaRateLimitGuard, TestJwtStrategy,
      { provide: StravaHttpClient, useValue: client },
      { provide: getQueueToken(STRAVA_UPLOAD_QUEUE), useValue: queue },
    ],
  }).compile();

  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const ds = moduleRef.get(DataSource);
  const crypto = moduleRef.get(StravaCryptoService);

  const insertId = async (sql: string, params: unknown[]): Promise<string> => String((await ds.query(sql, params)).insertId);

  const h = {
    app, ds, url, client, queue, crypto,
    cfg: moduleRef.get(StravaConfig),
    limiter: moduleRef.get(StravaRateLimitGuard),
    tokens: moduleRef.get(StravaTokenService),
    auth: moduleRef.get(StravaAuthService),
    activities: moduleRef.get(StravaActivityService),
    connections: ds.getRepository(StravaConnection),
    records: ds.getRepository(StravaActivity),
    states: ds.getRepository(StravaOauthState),

    jwt: (userId: string) => sign({ sub: userId }, JWT_SECRET, { expiresIn: '5m' }),

    async reset() {
      const qr = ds.createQueryRunner();
      await qr.query('SET FOREIGN_KEY_CHECKS=0');
      for (const t of ['strava_activities', 'strava_oauth_states', 'strava_connections', 'registrations', 'event_categories', 'events', 'organizations', 'runner_profiles', 'users']) {
        await qr.query(`TRUNCATE TABLE \`${t}\``);
      }
      await qr.query('SET FOREIGN_KEY_CHECKS=1');
      await qr.release();
      for (const fn of Object.values(client)) (fn as jest.Mock).mockReset();
      client.revoke.mockResolvedValue(undefined);
      queue.add.mockReset().mockResolvedValue({});
      h.limiter.clear(); // TRUNCATE resets user ids to 1, so per-user counters would leak between tests
    },

    seedUser: (email = `${randomUUID()}@test.dev`) => insertId('INSERT INTO users (email) VALUES (?)', [email]),

    async seedEvent(opts: { eventDate?: string; status?: string } = {}) {
      const owner = await h.seedUser();
      const orgId = await insertId('INSERT INTO organizations (owner_user_id, name) VALUES (?, ?)', [owner, 'Org']);
      const eventId = await insertId(
        `INSERT INTO events (organization_id, name, event_date, registration_start, registration_end, venue, location, status)
         VALUES (?, 'Baguio Fun Run', ?, '2026-01-01 00:00:00', '2026-12-31 00:00:00', 'Burnham Park', 'Baguio', ?)`,
        [orgId, opts.eventDate ?? today(), opts.status ?? 'reg_open'],
      );
      const categoryId = await insertId(
        `INSERT INTO event_categories (event_id, name, distance_km, price, slots_total, slots_remaining) VALUES (?, '5K', 5, 500, 100, 99)`,
        [eventId],
      );
      return { eventId, categoryId };
    },

    async seedRegistration(userId: string, opts: { eventId?: string; categoryId?: string; eventDate?: string; status?: string; groupId?: string | null; eventStatus?: string } = {}) {
      const ev = opts.eventId && opts.categoryId ? { eventId: opts.eventId, categoryId: opts.categoryId } : await h.seedEvent({ eventDate: opts.eventDate, status: opts.eventStatus });
      const id = await insertId(
        `INSERT INTO registrations (registration_code, event_id, category_id, runner_user_id, first_name, last_name, birthday, gender,
           mobile_number, email, emergency_contact_name, emergency_contact_number, status, group_id)
         VALUES (?, ?, ?, ?, 'Juan', 'Dela Cruz', '1990-01-01', 'male', '0917', 'j@test.dev', 'Ec', '0918', ?, ?)`,
        [`RF-${randomUUID().slice(0, 8)}`, ev.eventId, ev.categoryId, userId, opts.status ?? 'registered', opts.groupId ?? null],
      );
      return { registrationId: id, ...ev };
    },

    /** Insert a connected Strava account directly (tokens encrypted exactly like production). */
    async seedConnection(userId: string, o: { expiresInSec?: number; scopes?: string; athleteId?: string; connected?: boolean } = {}) {
      const row = h.connections.create({
        userId,
        stravaAthleteId: o.athleteId ?? String(1_000_000 + Number(userId)),
        athleteDisplayName: 'Test Athlete',
        accessTokenEncrypted: crypto.encrypt(`AT-${userId}`, userId),
        refreshTokenEncrypted: crypto.encrypt(`RT-${userId}`, userId),
        expiresAt: new Date(Date.now() + (o.expiresInSec ?? 6 * 3600) * 1000),
        scopes: o.scopes ?? 'activity:write',
        isConnected: o.connected ?? true,
      });
      return h.connections.save(row);
    },

    async api(method: string, path: string, o: { token?: string; json?: unknown; form?: FormData } = {}) {
      const headers: Record<string, string> = {};
      if (o.token) headers.Authorization = `Bearer ${o.token}`;
      if (o.json !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${url}/api${path}`, {
        method, headers, body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined),
      });
      const text = await res.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      return { status: res.status, body };
    },

    close: async () => { await app.close(); },
  };
  return h;
}
export type Harness = Awaited<ReturnType<typeof buildHarness>>;

/** Asserts an HttpException with an exact status and (optionally) Strava error code. */
export async function expectHttp(p: Promise<unknown>, status: number, code?: string) {
  const err: any = await p.then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(err.getStatus?.()).toBe(status);
  if (code) expect(err.getResponse().error).toBe(code);
  return err;
}
