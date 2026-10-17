import { INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { dataSourceOptions } from '../data-source';
import { StravaModule } from './strava.module';
import { StravaHttpClient } from './strava-http.client';
import { StravaApiError } from './strava.errors';
import { TEST_ENV, buildHarness, dbConfigured, Harness, today } from './testing/harness';

/**
 * End-to-end: the REAL StravaModule (controller, guards, Multer config, BullMQ queue + processor)
 * on real MySQL and real Redis, with only Strava's HTTP edge stubbed.
 * Needs STRAVA_TEST_REDIS_PORT (a scratch Redis — the queue is flushed) in addition to the DB vars.
 */
const enabled = dbConfigured() && !!process.env.STRAVA_TEST_REDIS_PORT;
const d = enabled ? describe : describe.skip;

@Injectable()
class E2eJwtStrategy extends PassportStrategy(Strategy) {
  constructor() { super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: 'test-secret' }); }
  validate(p: { sub: string }) { return { id: p.sub, role: 'runner' }; }
}

const processing = { id: 555, id_str: '555', external_id: null, error: null, status: 'Your activity is still being processed.', activity_id: null };
const ready = { ...processing, status: 'Your activity is ready.', activity_id: 777 };
const gpx = () =>
  `<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><trkseg><trkpt lat="16.4" lon="120.6"><time>${new Date(`${today()}T06:00:00+08:00`).toISOString()}</time></trkpt></trkseg></trk></gpx>`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('Strava upload polling (real module + BullMQ + Redis)', () => {
  let h: Harness;
  let app: INestApplication;
  let url: string;
  const stub = { exchangeCode: jest.fn(), refresh: jest.fn(), revoke: jest.fn(), createActivity: jest.fn(), createUpload: jest.fn(), getUpload: jest.fn() };
  const redisPort = Number(process.env.STRAVA_TEST_REDIS_PORT);

  beforeAll(async () => {
    h = await buildHarness(); // used for seeding/inspection only
    await new Redis({ port: redisPort }).flushall();
    Object.assign(process.env, TEST_ENV);
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => TEST_ENV] }),
        TypeOrmModule.forRoot({
          ...dataSourceOptions, host: process.env.STRAVA_TEST_DB_HOST ?? '127.0.0.1', port: Number(process.env.STRAVA_TEST_DB_PORT ?? 3306),
          username: process.env.STRAVA_TEST_DB_USER, password: process.env.STRAVA_TEST_DB_PASSWORD, database: process.env.STRAVA_TEST_DB_NAME, logging: false, retryAttempts: 0,
        } as any),
        BullModule.forRoot({ connection: { host: '127.0.0.1', port: redisPort } }),
        PassportModule,
        StravaModule,
      ],
      providers: [E2eJwtStrategy],
    })
      .overrideProvider(StravaHttpClient).useValue(stub)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.setGlobalPrefix('api');
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => { await app?.close(); await h?.close(); });
  beforeEach(async () => { await h.reset(); for (const f of Object.values(stub)) f.mockReset(); });

  async function submitUpload() {
    const userId = await h.seedUser();
    await h.seedConnection(userId);
    const { registrationId } = await h.seedRegistration(userId);
    const token = h.jwt(userId);
    const form = new FormData();
    form.set('registrationId', registrationId);
    form.set('clientRequestId', randomUUID());
    form.set('confirmed', 'true');
    form.set('file', new Blob([gpx()], { type: 'application/gpx+xml' }), 'run.gpx');
    const res = await fetch(`${url}/api/strava/activities/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { token, userId, res, body: (await res.json()) as any };
  }
  async function waitFor(token: string, id: string, status: string, timeoutMs = 25_000) {
    const end = Date.now() + timeoutMs;
    let last: any;
    while (Date.now() < end) {
      last = await (await fetch(`${url}/api/strava/activities/${id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
      if (last.status === status) return last;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${status}; last=${JSON.stringify(last)}`);
  }

  it('the module boots with its real wiring (controller, queue, processor, Multer limits)', () => {
    expect(app).toBeDefined();
  });

  it('a queued poll job drives a processing upload to "completed" without any user action', async () => {
    stub.createUpload.mockResolvedValue(processing);
    stub.getUpload.mockResolvedValueOnce(processing).mockResolvedValue(ready);
    const { token, res, body } = await submitUpload();
    expect(res.status).toBe(201);
    expect(body.status).toBe('processing');

    const done = await waitFor(token, body.id, 'completed');
    expect(done).toMatchObject({ stravaActivityId: '777', stravaUrl: 'https://www.strava.com/activities/777' });
    expect(stub.getUpload.mock.calls.length).toBe(2);
    expect(stub.createUpload).toHaveBeenCalledTimes(1);

    await sleep(3500); // a settled record must not keep being polled
    expect(stub.getUpload.mock.calls.length).toBe(2);
  }, 40_000);

  it('survives transient Strava errors while polling and still completes', async () => {
    stub.createUpload.mockResolvedValue(processing);
    stub.getUpload
      .mockRejectedValueOnce(new StravaApiError('http', 503, '<html/>'))
      .mockRejectedValueOnce(new StravaApiError('network_ambiguous', null, null))
      .mockResolvedValue(ready);
    const { token, body } = await submitUpload();
    const done = await waitFor(token, body.id, 'completed');
    expect(done.stravaActivityId).toBe('777');
    expect(stub.getUpload.mock.calls.length).toBe(3);
  }, 45_000);

  it('a Strava-side processing error ends the loop as "failed" with a safe message', async () => {
    stub.createUpload.mockResolvedValue(processing);
    stub.getUpload.mockResolvedValue({ ...processing, error: 'The file contains no activity data.', status: 'There was an error processing your activity.' });
    const { token, body } = await submitUpload();
    const failed = await waitFor(token, body.id, 'failed');
    expect(failed.errorMessage).toContain('no activity data');
    expect(failed.action).toBe('reupload');
  }, 40_000);

  it('the upload size limit configured in StravaModule is enforced on the real route (413)', async () => {
    const userId = await h.seedUser();
    await h.seedConnection(userId);
    const { registrationId } = await h.seedRegistration(userId);
    const form = new FormData();
    form.set('registrationId', registrationId); form.set('clientRequestId', randomUUID()); form.set('confirmed', 'true');
    form.set('file', new Blob([Buffer.alloc(10_000, 'a')], { type: 'application/gpx+xml' }), 'big.gpx'); // TEST_ENV limit = 4096
    const res = await fetch(`${url}/api/strava/activities/upload`, { method: 'POST', headers: { Authorization: `Bearer ${h.jwt(userId)}` }, body: form });
    expect(res.status).toBe(413);
    expect(stub.createUpload).not.toHaveBeenCalled();
  });
});
