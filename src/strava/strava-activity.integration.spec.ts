import { randomUUID } from 'crypto';
import { StravaApiError } from './strava.errors';
import { pollDelayMs } from './strava-activity.service';
import { buildHarness, dbConfigured, daysFromToday, expectHttp, Harness, today } from './testing/harness';

const d = dbConfigured() ? describe : describe.skip;
const future = () => Math.floor(Date.now() / 1000) + 21_600;

const gpx = (isoTime: string) =>
  `<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><trkseg><trkpt lat="16.4" lon="120.6"><time>${isoTime}</time></trkpt></trkseg></trk></gpx>`;
// Manila 06:00 today, expressed in UTC
const raceDayGpx = () => gpx(new Date(`${today()}T06:00:00+08:00`).toISOString().replace('.000Z', 'Z'));
const gpxFile = (xml = raceDayGpx()) => ({ originalname: 'run.gpx', mimetype: 'application/gpx+xml', size: Buffer.byteLength(xml), buffer: Buffer.from(xml) });

const processing = (over: Record<string, unknown> = {}) => ({ id: 555, id_str: '555', external_id: null, error: null, status: 'Your activity is still being processed.', activity_id: null, ...over });
const ready = (activityId = 777) => processing({ status: 'Your activity is ready.', activity_id: activityId });

d('Strava activities (database-backed)', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.reset(); });

  /** A runner with a connected Strava account and a paid registration for an event that is happening today. */
  async function runner(reg: Parameters<Harness['seedRegistration']>[1] = {}) {
    const userId = await h.seedUser();
    await h.seedConnection(userId);
    const r = await h.seedRegistration(userId, reg);
    return { userId, ...r };
  }
  const manual = (registrationId: string, over: Record<string, unknown> = {}) => ({
    registrationId, clientRequestId: randomUUID(), name: 'Baguio Fun Run', sportType: 'Run', distanceMeters: 5000,
    elapsedTimeSeconds: 1800, startDateLocal: `${today()}T00:00:00`, confirmed: true, ...over,
  }) as any;
  const upload = (registrationId: string, over: Record<string, unknown> = {}) => ({ registrationId, clientRequestId: randomUUID(), confirmed: true, ...over }) as any;

  // ===========================================================================================
  describe('eligibility & ownership', () => {
    it("treats someone else's registration as not found and never calls Strava", async () => {
      const mine = await runner();
      const intruder = await h.seedUser();
      await h.seedConnection(intruder);
      await expectHttp(h.activities.createManual(intruder, manual(mine.registrationId)), 404);
      await expectHttp(h.activities.createUpload(intruder, upload(mine.registrationId), gpxFile()), 404);
      expect(h.client.createActivity).not.toHaveBeenCalled();
      expect(h.client.createUpload).not.toHaveBeenCalled();
      expect(await h.records.count()).toBe(0);
    });

    it('returns 404 (not 403) for non-existent registrations so ids cannot be probed', async () => {
      const { userId } = await runner();
      await expectHttp(h.activities.createManual(userId, manual('99999999')), 404);
    });

    it('blocks group/guest registrations (the account holder is not necessarily the runner)', async () => {
      const userId = await h.seedUser();
      await h.seedConnection(userId);
      const { registrationId } = await h.seedRegistration(userId, { groupId: '1' });
      await expectHttp(h.activities.createManual(userId, manual(registrationId)), 400, 'STRAVA_NOT_ELIGIBLE');
    });

    it.each(['pending_payment', 'cancelled'])('blocks a %s registration', async (status) => {
      const userId = await h.seedUser();
      await h.seedConnection(userId);
      const { registrationId } = await h.seedRegistration(userId, { status });
      await expectHttp(h.activities.createManual(userId, manual(registrationId)), 400, 'STRAVA_NOT_ELIGIBLE');
    });

    it.each(['registered', 'checked_in', 'completed'])('allows a %s registration', async (status) => {
      const userId = await h.seedUser();
      await h.seedConnection(userId);
      const { registrationId } = await h.seedRegistration(userId, { status });
      h.client.createActivity.mockResolvedValue({ id: 1 });
      await expect(h.activities.createManual(userId, manual(registrationId))).resolves.toMatchObject({ status: 'completed' });
    });

    it('blocks events that have not happened yet', async () => {
      const userId = await h.seedUser();
      await h.seedConnection(userId);
      const { registrationId } = await h.seedRegistration(userId, { eventDate: daysFromToday(3) });
      await expectHttp(h.activities.createManual(userId, manual(registrationId)), 400, 'STRAVA_EVENT_NOT_STARTED');
      await expectHttp(h.activities.createUpload(userId, upload(registrationId), gpxFile()), 400, 'STRAVA_EVENT_NOT_STARTED');
    });

    it('blocks cancelled and draft events', async () => {
      for (const eventStatus of ['cancelled', 'draft']) {
        const userId = await h.seedUser();
        await h.seedConnection(userId);
        const { registrationId } = await h.seedRegistration(userId, { eventStatus });
        await expectHttp(h.activities.createManual(userId, manual(registrationId)), 400, 'STRAVA_NOT_ELIGIBLE');
      }
    });

    it('does not mark the registration completed just because an activity was created', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      await h.activities.createManual(userId, manual(registrationId));
      const [reg] = await h.ds.query('SELECT status FROM registrations WHERE id = ?', [registrationId]);
      expect(reg.status).toBe('registered');
    });

    it('requires a connected account, with activity:write', async () => {
      const userId = await h.seedUser();
      const { registrationId } = await h.seedRegistration(userId);
      await expectHttp(h.activities.createManual(userId, manual(registrationId)), 409, 'STRAVA_NOT_CONNECTED');
      await h.seedConnection(userId, { scopes: 'read' });
      await expectHttp(h.activities.createManual(userId, manual(registrationId)), 403, 'STRAVA_MISSING_SCOPE');
      expect(h.client.createActivity).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================================
  describe('workflow A — manual activity', () => {
    it('sends exactly the runner-entered values to Strava and stores the result', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 8675309, moving_time: 1795 });
      const dto = manual(registrationId, { name: '  My Race  ', distanceMeters: 4873.5, elapsedTimeSeconds: 1790, sportType: 'TrailRun', description: 'felt great', startDateLocal: `${today()}T05:45` });

      const view = await h.activities.createManual(userId, dto);

      expect(h.client.createActivity).toHaveBeenCalledTimes(1);
      expect(h.client.createActivity).toHaveBeenCalledWith(`AT-${userId}`, {
        name: 'My Race', sport_type: 'TrailRun', start_date_local: `${today()}T05:45:00`, elapsed_time: 1790, distance: 4873.5, description: 'felt great',
      });
      expect(view).toMatchObject({
        status: 'completed', stravaActivityId: '8675309', stravaUrl: 'https://www.strava.com/activities/8675309',
        distanceMeters: 4873.5, elapsedTimeSeconds: 1790, movingTimeSeconds: 1795, activityName: 'My Race', errorCode: null, action: null,
      });
      // The 5K category's advertised distance (5 km) must never be substituted for what the runner entered.
      expect(view.distanceMeters).not.toBe(5000);
    });

    it('public view leaks no internals (user/connection ids, keys, hashes, tokens)', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      const json = JSON.stringify(await h.activities.createManual(userId, manual(registrationId)));
      expect(json).not.toMatch(/userId|connection|activeRegistrationKey|activeFileKey|fileSha256|clientRequestId|token|AT-|RT-/i);
    });

    it('requires explicit confirmation at the DTO layer (see controller spec) and validates values here', async () => {
      const { userId, registrationId } = await runner();
      await expectHttp(h.activities.createManual(userId, manual(registrationId, { startDateLocal: `${daysFromToday(-1)}T07:00` })), 400, 'STRAVA_ACTIVITY_DATE_MISMATCH');
      await expectHttp(h.activities.createManual(userId, manual(registrationId, { startDateLocal: `${daysFromToday(1)}T07:00` })), 400, 'STRAVA_ACTIVITY_DATE_MISMATCH');
      await expectHttp(h.activities.createManual(userId, manual(registrationId, { distanceMeters: 42_000, elapsedTimeSeconds: 600 })), 400);
      expect(h.client.createActivity).not.toHaveBeenCalled();
      expect(await h.records.count()).toBe(0);
    });

    it('rejects a start time later today that has not happened yet', async () => {
      const { userId, registrationId } = await runner();
      // 23:59 local today is only "future" before 23:59; skip if the suite happens to run in that minute
      const now = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila', hour12: false }).slice(0, 5);
      if (now >= '23:58') return;
      await expectHttp(h.activities.createManual(userId, manual(registrationId, { startDateLocal: `${today()}T23:59` })), 400, 'STRAVA_ACTIVITY_DATE_MISMATCH');
    });

    // ----- idempotency -----------------------------------------------------------------------
    it('replaying the same clientRequestId returns the same record and does not call Strava again', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      const dto = manual(registrationId);
      const a = await h.activities.createManual(userId, dto);
      const b = await h.activities.createManual(userId, dto);
      expect(b.id).toBe(a.id);
      expect(h.client.createActivity).toHaveBeenCalledTimes(1);
      expect(await h.records.count()).toBe(1);
    });

    it('five simultaneous identical requests (double-click / flaky network) create ONE Strava activity', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 100)); return { id: 42 }; });
      const dto = manual(registrationId);
      const results = await Promise.all(Array.from({ length: 5 }, () => h.activities.createManual(userId, dto)));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(h.client.createActivity).toHaveBeenCalledTimes(1);
      expect(await h.records.count()).toBe(1);
    });

    it('a second submission (new request id) for the same registration is refused', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      await h.activities.createManual(userId, manual(registrationId));
      await expectHttp(h.activities.createManual(userId, manual(registrationId)), 409, 'STRAVA_DUPLICATE_ACTIVITY');
      await expectHttp(h.activities.createUpload(userId, upload(registrationId), gpxFile()), 409, 'STRAVA_DUPLICATE_ACTIVITY');
      expect(h.client.createActivity).toHaveBeenCalledTimes(1);
      expect(h.client.createUpload).not.toHaveBeenCalled();
    });

    it('simultaneous DIFFERENT requests for one registration: exactly one reaches Strava', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 80)); return { id: 7 }; });
      const settled = await Promise.allSettled(Array.from({ length: 6 }, () => h.activities.createManual(userId, manual(registrationId))));
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(5);
      expect(h.client.createActivity).toHaveBeenCalledTimes(1);
    });

    it('different users and different registrations do not collide', async () => {
      const a = await runner();
      const b = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      const sameRequestId = randomUUID(); // client ids are scoped per user
      await h.activities.createManual(a.userId, manual(a.registrationId, { clientRequestId: sameRequestId }));
      h.client.createActivity.mockResolvedValue({ id: 2 });
      await expect(h.activities.createManual(b.userId, manual(b.registrationId, { clientRequestId: sameRequestId }))).resolves.toMatchObject({ stravaActivityId: '2' });
    });

    // ----- failure semantics ------------------------------------------------------------------
    it('a TIMEOUT is "needs_review": never auto-retried, registration stays locked, user must confirm', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValue(new StravaApiError('network_ambiguous', null, null));
      const v = await h.activities.createManual(userId, manual(registrationId));
      expect(v).toMatchObject({ status: 'needs_review', action: 'resolve', stravaActivityId: null });
      expect(v.errorMessage).toMatch(/Check your Strava profile/);
      expect(h.client.createActivity).toHaveBeenCalledTimes(1); // no hidden retry

      await expectHttp(h.activities.createManual(userId, manual(registrationId)), 409, 'STRAVA_DUPLICATE_ACTIVITY'); // still locked
      await expectHttp(h.activities.retry(userId, v.id, {}), 400, 'STRAVA_CONFIRMATION_REQUIRED');
      await expectHttp(h.activities.retry(userId, v.id, { confirmNotOnStrava: false }), 400, 'STRAVA_CONFIRMATION_REQUIRED');
      expect(h.client.createActivity).toHaveBeenCalledTimes(1);

      h.client.createActivity.mockResolvedValue({ id: 31337 });
      const retried = await h.activities.retry(userId, v.id, { confirmNotOnStrava: true });
      expect(retried).toMatchObject({ id: v.id, status: 'completed', stravaActivityId: '31337' });
      expect(h.client.createActivity).toHaveBeenCalledTimes(2);
    });

    it.each([500, 502, 503])('a %i from Strava is ambiguous too (the server may have created it)', async (status) => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValue(new StravaApiError('http', status, '<html>bad gateway</html>'));
      const v = await h.activities.createManual(userId, manual(registrationId));
      expect(v.status).toBe('needs_review');
      expect(JSON.stringify(v)).not.toContain('<html>');
    });

    it('a definite 400 rejection fails, is NOT retryable as-is, and frees the registration for a corrected submission', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValue(new StravaApiError('http', 400, { message: 'Bad Request', errors: [{ field: 'elapsed_time' }] }));
      const v = await h.activities.createManual(userId, manual(registrationId));
      expect(v).toMatchObject({ status: 'failed', action: null });
      await expectHttp(h.activities.retry(userId, v.id, {}), 409, 'STRAVA_NOT_RETRYABLE');
      h.client.createActivity.mockResolvedValue({ id: 5 });
      await expect(h.activities.createManual(userId, manual(registrationId))).resolves.toMatchObject({ status: 'completed' });
    });

    it('a 429 from Strava fails as retryable (it provably was not processed) and a retry succeeds', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValueOnce(new StravaApiError('http', 429, null, 840));
      const v = await h.activities.createManual(userId, manual(registrationId));
      expect(v).toMatchObject({ status: 'failed', action: 'retry', errorCode: 'STRAVA_RATE_LIMITED' });
      expect(v.errorMessage).toMatch(/minute/);
      h.client.createActivity.mockResolvedValueOnce({ id: 11 });
      await expect(h.activities.retry(userId, v.id, {})).resolves.toMatchObject({ id: v.id, status: 'completed', stravaActivityId: '11' });
    });

    it('DNS/connection-refused failures are safe to retry', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValueOnce(new StravaApiError('network_definite', null, null));
      const v = await h.activities.createManual(userId, manual(registrationId));
      expect(v).toMatchObject({ status: 'failed', action: 'retry' });
    });

    it('a 401 (expired token) is refreshed and retried once transparently', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValueOnce(new StravaApiError('http', 401, {})).mockResolvedValueOnce({ id: 3 });
      h.client.refresh.mockResolvedValue({ access_token: 'AT-fresh', refresh_token: 'RT-fresh', expires_at: future(), token_type: 'Bearer' });
      await expect(h.activities.createManual(userId, manual(registrationId))).resolves.toMatchObject({ status: 'completed' });
      expect(h.client.createActivity.mock.calls.map((c) => c[0])).toEqual([`AT-${userId}`, 'AT-fresh']);
    });

    it('revoked access fails as retryable-after-reconnect with a 409-class message and flags the connection', async () => {
      const { userId, registrationId } = await runner();
      await h.ds.query('UPDATE strava_connections SET expires_at = NOW() - INTERVAL 1 HOUR');
      h.client.refresh.mockRejectedValue(new StravaApiError('http', 400, {}));
      const v = await h.activities.createManual(userId, manual(registrationId));
      expect(v).toMatchObject({ status: 'failed', errorCode: 'STRAVA_REVOKED', action: 'retry' });
      expect(h.client.createActivity).not.toHaveBeenCalled();
      expect(await h.auth.getStatus(userId)).toMatchObject({ connected: false, disconnectReason: 'revoked' });
      await expectHttp(h.activities.retry(userId, v.id, {}), 409, 'STRAVA_NOT_CONNECTED'); // must reconnect first
    });

    it('a 403 (missing permission) marks the connection and fails as retryable-after-reconnect', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValue(new StravaApiError('http', 403, {}));
      const v = await h.activities.createManual(userId, manual(registrationId));
      expect(v).toMatchObject({ status: 'failed', errorCode: 'STRAVA_MISSING_SCOPE' });
      expect(await h.auth.getStatus(userId)).toMatchObject({ connected: false, disconnectReason: 'insufficient_scope' });
    });

    it('never stores or exposes tokens or raw upstream bodies in error messages', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValue(new StravaApiError('http', 400, { message: `Authorization: Bearer AT-${userId}` }));
      await h.activities.createManual(userId, manual(registrationId));
      const rows = JSON.stringify(await h.ds.query('SELECT error_code, error_message, description FROM strava_activities'));
      expect(rows).not.toMatch(/AT-|Bearer/);
    });

    it('retry refuses completed/other-user records and re-checks ownership', async () => {
      const a = await runner();
      const b = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      const v = await h.activities.createManual(a.userId, manual(a.registrationId));
      await expectHttp(h.activities.retry(a.userId, v.id, { confirmNotOnStrava: true }), 409, 'STRAVA_NOT_RETRYABLE');
      await expectHttp(h.activities.retry(b.userId, v.id, { confirmNotOnStrava: true }), 404);
    });

    it('concurrent retries of one needs_review record reach Strava once', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockRejectedValueOnce(new StravaApiError('network_ambiguous', null, null));
      const v = await h.activities.createManual(userId, manual(registrationId));
      h.client.createActivity.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 80)); return { id: 9 }; });
      const settled = await Promise.allSettled(Array.from({ length: 5 }, () => h.activities.retry(userId, v.id, { confirmNotOnStrava: true })));
      expect(settled.filter((s) => s.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
      expect(h.client.createActivity).toHaveBeenCalledTimes(2); // 1 original + exactly 1 retry
    });

    it('a Strava activity id can only be linked to one record', async () => {
      const a = await runner();
      const b = await runner();
      h.client.createActivity.mockResolvedValue({ id: 123 });
      await h.activities.createManual(a.userId, manual(a.registrationId));
      const second = await h.activities.createManual(b.userId, manual(b.registrationId));
      expect(second).toMatchObject({ status: 'failed', errorCode: 'STRAVA_DUPLICATE_ACTIVITY' });
    });
  });

  // ===========================================================================================
  describe('workflow B — recorded file upload', () => {
    it('uploads, records the Strava upload id, and schedules a poll (no file is ever written to disk)', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing());
      const file = gpxFile();
      const v = await h.activities.createUpload(userId, upload(registrationId, { name: 'Race day', description: 'PR!' }), file);

      expect(h.client.createUpload).toHaveBeenCalledTimes(1);
      const [token, args] = h.client.createUpload.mock.calls[0];
      expect(token).toBe(`AT-${userId}`);
      expect(args).toMatchObject({ dataType: 'gpx', name: 'Race day', description: 'PR!' });
      expect(args.file.equals(file.buffer)).toBe(true);
      expect(args.externalId).toBe(`runflow-${v.id}`);
      expect(v).toMatchObject({ status: 'processing', kind: 'upload', stravaActivityId: null });
      expect(h.queue.add).toHaveBeenCalledWith('poll', { activityId: v.id }, expect.objectContaining({ delay: 2000, jobId: `poll-${v.id}-0` }));
    });

    it('polling: still processing -> keeps going; ready -> completes with the Strava activity id', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing());
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());

      h.client.getUpload.mockResolvedValueOnce(processing());
      await expect(h.activities.pollUpload(v.id)).resolves.toEqual({ done: false, delayMs: 2000 });
      expect((await h.activities.get(userId, v.id)).status).toBe('processing');

      h.client.getUpload.mockResolvedValueOnce(ready(777));
      await expect(h.activities.pollUpload(v.id)).resolves.toEqual({ done: true });
      expect(await h.activities.get(userId, v.id)).toMatchObject({ status: 'completed', stravaActivityId: '777', stravaUrl: 'https://www.strava.com/activities/777' });
      expect(h.client.getUpload).toHaveBeenCalledWith(`AT-${userId}`, '555');
      // a settled record is never polled again
      await expect(h.activities.pollUpload(v.id)).resolves.toEqual({ done: true });
      expect(h.client.getUpload).toHaveBeenCalledTimes(2);
    });

    it('completes immediately when the first response already carries an activity id', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(ready(888));
      await expect(h.activities.createUpload(userId, upload(registrationId), gpxFile())).resolves.toMatchObject({ status: 'completed', stravaActivityId: '888' });
      expect(h.queue.add).not.toHaveBeenCalled();
    });

    it('surfaces Strava processing errors (sanitised) and allows uploading a corrected file', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing({ status: 'There was an error processing your activity.', error: '<b>The file</b> is empty or has no data.' }));
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      expect(v).toMatchObject({ status: 'failed', errorCode: 'STRAVA_UPLOAD_REJECTED', action: 'reupload' });
      expect(v.errorMessage).toContain('The file is empty or has no data.');
      expect(v.errorMessage).not.toContain('<b>');
      h.client.createUpload.mockResolvedValue(processing());
      await expect(h.activities.createUpload(userId, upload(registrationId), gpxFile(raceDayGpx().replace('lat="16.4"', 'lat="16.5"')))).resolves.toMatchObject({ status: 'processing' });
    });

    it('"duplicate of activity N" links the runner\'s existing Strava activity instead of failing', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing({ error: 'run.gpx duplicate of activity 21234316', status: 'There was an error processing your activity.' }));
      await expect(h.activities.createUpload(userId, upload(registrationId), gpxFile())).resolves.toMatchObject({ status: 'completed', stravaActivityId: '21234316' });
    });

    it('detects a deleted activity while polling', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing());
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      h.client.getUpload.mockResolvedValueOnce(processing({ status: 'The created activity has been deleted.' }));
      await h.activities.pollUpload(v.id);
      expect(await h.activities.get(userId, v.id)).toMatchObject({ status: 'failed', errorCode: 'STRAVA_UPLOAD_DELETED' });
    });

    // ----- duplicate prevention ---------------------------------------------------------------
    it('the same file cannot be live twice for one user (even for another registration)', async () => {
      const { userId, registrationId } = await runner();
      const other = await h.seedRegistration(userId);
      h.client.createUpload.mockResolvedValue(processing());
      await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      const err = await expectHttp(h.activities.createUpload(userId, upload(other.registrationId), gpxFile()), 409, 'STRAVA_DUPLICATE_ACTIVITY');
      expect(err.getResponse().message).toMatch(/already been submitted/);
      expect(h.client.createUpload).toHaveBeenCalledTimes(1);
    });

    it('simultaneous identical uploads reach Strava once', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 100)); return processing(); });
      const dto = upload(registrationId);
      const res = await Promise.all(Array.from({ length: 4 }, () => h.activities.createUpload(userId, dto, gpxFile())));
      expect(new Set(res.map((r) => r.id)).size).toBe(1);
      expect(h.client.createUpload).toHaveBeenCalledTimes(1);
    });

    // ----- validation: nothing is created for bad input -----------------------------------------
    it('invalid files create no record and make no Strava call', async () => {
      const { userId, registrationId } = await runner();
      for (const bad of [
        undefined,
        { originalname: 'run.gpx', mimetype: 'application/gpx+xml', size: 5, buffer: Buffer.from('nope!') },
        { originalname: 'run.exe', mimetype: 'application/octet-stream', size: 3, buffer: Buffer.from('MZ\0') },
        { originalname: 'big.gpx', mimetype: 'text/xml', size: 5000, buffer: Buffer.alloc(5000, 'a') }, // limit is 4096 in tests
      ]) {
        await expect(h.activities.createUpload(userId, upload(registrationId), bad as any)).rejects.toBeTruthy();
      }
      expect(h.client.createUpload).not.toHaveBeenCalled();
      expect(await h.records.count()).toBe(0);
    });

    it('rejects a file whose recorded start is not on the event day', async () => {
      const { userId, registrationId } = await runner();
      const lastWeek = gpx(new Date(Date.now() - 7 * 86_400_000).toISOString());
      await expectHttp(h.activities.createUpload(userId, upload(registrationId), gpxFile(lastWeek)), 400, 'STRAVA_ACTIVITY_DATE_MISMATCH');
      const tomorrow = gpx(new Date(Date.now() + 2 * 86_400_000).toISOString());
      await expectHttp(h.activities.createUpload(userId, upload(registrationId), gpxFile(tomorrow)), 400, 'STRAVA_ACTIVITY_DATE_MISMATCH');
      expect(h.client.createUpload).not.toHaveBeenCalled();
    });

    // ----- polling resilience -----------------------------------------------------------------
    it('transient poll errors keep polling; 429 waits as long as Strava asked', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing());
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      h.client.getUpload.mockRejectedValueOnce(new StravaApiError('http', 503, '<html/>'));
      await expect(h.activities.pollUpload(v.id)).resolves.toMatchObject({ done: false });
      h.client.getUpload.mockRejectedValueOnce(new StravaApiError('network_ambiguous', null, null));
      await expect(h.activities.pollUpload(v.id)).resolves.toMatchObject({ done: false });
      h.client.getUpload.mockRejectedValueOnce(new StravaApiError('http', 429, null, 420));
      await expect(h.activities.pollUpload(v.id)).resolves.toEqual({ done: false, delayMs: 420_000 });
      expect((await h.activities.get(userId, v.id)).status).toBe('processing');
    });

    it('gives up after the poll budget with needs_review, and "check status" resumes safely (read-only)', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing());
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      await h.ds.query('UPDATE strava_activities SET poll_attempts = 40 WHERE id = ?', [v.id]);
      await expect(h.activities.pollUpload(v.id)).resolves.toEqual({ done: true });
      const stuck = await h.activities.get(userId, v.id);
      expect(stuck).toMatchObject({ status: 'needs_review', action: 'check', errorCode: 'STRAVA_PROCESSING_TIMEOUT' });

      h.queue.add.mockClear();
      const resumed = await h.activities.retry(userId, v.id, {}); // no confirmation needed: nothing is re-sent
      expect(resumed.status).toBe('processing');
      expect(h.client.createUpload).toHaveBeenCalledTimes(1);
      expect(h.queue.add).toHaveBeenCalledWith('poll', { activityId: v.id }, expect.any(Object));
    });

    it('if Strava was disconnected mid-upload the record needs review (the upload exists upstream)', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing());
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      await h.auth.disconnect(userId);
      await expect(h.activities.pollUpload(v.id)).resolves.toEqual({ done: true });
      expect(await h.activities.get(userId, v.id)).toMatchObject({ status: 'needs_review', errorCode: 'STRAVA_REVOKED' });
      expect(h.client.getUpload).not.toHaveBeenCalled();
    });

    it('an upload TIMEOUT (no upload id) needs review; confirming "not on Strava" unlocks a fresh upload', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockRejectedValueOnce(new StravaApiError('network_ambiguous', null, null));
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      expect(v).toMatchObject({ status: 'needs_review', action: 'resolve' });
      await expectHttp(h.activities.createUpload(userId, upload(registrationId), gpxFile()), 409, 'STRAVA_DUPLICATE_ACTIVITY');
      await expectHttp(h.activities.retry(userId, v.id, {}), 400, 'STRAVA_CONFIRMATION_REQUIRED');
      expect(h.client.createUpload).toHaveBeenCalledTimes(1); // never re-sent automatically
      expect(await h.activities.retry(userId, v.id, { confirmNotOnStrava: true })).toMatchObject({ status: 'failed', action: 'reupload' });
      h.client.createUpload.mockResolvedValue(processing());
      await expect(h.activities.createUpload(userId, upload(registrationId), gpxFile())).resolves.toMatchObject({ status: 'processing' });
    });

    it('a failed upload cannot be "retried" (the file is not stored); it must be uploaded again', async () => {
      const { userId, registrationId } = await runner();
      h.client.createUpload.mockResolvedValue(processing({ error: 'bad data' }));
      const v = await h.activities.createUpload(userId, upload(registrationId), gpxFile());
      await expectHttp(h.activities.retry(userId, v.id, {}), 409, 'STRAVA_NOT_RETRYABLE');
    });

    it('poll backoff schedule is bounded: ~5 min total across 40 polls', () => {
      let total = 0;
      for (let a = 1; a <= 40; a++) total += pollDelayMs(a);
      expect(total).toBeGreaterThan(4 * 60_000);
      expect(total).toBeLessThan(6 * 60_000);
    });
  });

  // ===========================================================================================
  describe('reads', () => {
    it('lists only the caller\'s records, newest first, with event context', async () => {
      const a = await runner();
      const b = await runner();
      h.client.createActivity.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 });
      await h.activities.createManual(a.userId, manual(a.registrationId));
      await h.activities.createManual(b.userId, manual(b.registrationId));
      const mine = await h.activities.list(a.userId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ event: { name: 'Baguio Fun Run', eventDate: today() }, categoryName: '5K', stravaActivityId: '1' });
      expect(await h.activities.list(a.userId, b.registrationId)).toHaveLength(0);
    });

    it("get() 404s for other people's records", async () => {
      const a = await runner();
      const b = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      const v = await h.activities.createManual(a.userId, manual(a.registrationId));
      await expectHttp(h.activities.get(b.userId, v.id), 404);
      await expect(h.activities.get(a.userId, v.id)).resolves.toMatchObject({ id: v.id });
    });

    it('reconciles work orphaned by a crash so nothing is stuck forever', async () => {
      const a = await runner();
      const mk = (over: Record<string, unknown>) =>
        h.records.save(h.records.create({ userId: a.userId, registrationId: a.registrationId, stravaConnectionId: (undefined as any), kind: 'manual' as any, clientRequestId: randomUUID(), ...over }));
      const conn = await h.connections.findOneByOrFail({ userId: a.userId });
      // never sent (crash before the claim): provably not at Strava -> failed
      const pending = await mk({ stravaConnectionId: conn.id, status: 'pending' as any, activeRegistrationKey: a.registrationId });
      await h.ds.query('UPDATE strava_activities SET updated_at = NOW() - INTERVAL 20 MINUTE WHERE id = ?', [pending.id]);
      expect((await h.activities.list(a.userId))[0]).toMatchObject({ status: 'failed' });
      // registration is free again
      h.client.createActivity.mockResolvedValue({ id: 9 });
      await expect(h.activities.createManual(a.userId, manual(a.registrationId))).resolves.toMatchObject({ status: 'completed' });

      // sent but no outcome recorded (crash after sending): unknown -> needs_review
      const b = await runner();
      const connB = await h.connections.findOneByOrFail({ userId: b.userId });
      const proc = await h.records.save(h.records.create({
        userId: b.userId, registrationId: b.registrationId, stravaConnectionId: connB.id, kind: 'manual' as any,
        clientRequestId: randomUUID(), status: 'processing' as any, activeRegistrationKey: b.registrationId,
      }));
      await h.ds.query('UPDATE strava_activities SET updated_at = NOW() - INTERVAL 30 MINUTE WHERE id = ?', [proc.id]);
      expect((await h.activities.list(b.userId))[0]).toMatchObject({ status: 'needs_review' });
    });
  });

  // ===========================================================================================
  describe('database-level guarantees (independent of application code)', () => {
    it('unique keys reject duplicates and treat NULL as "not active" (MySQL semantics)', async () => {
      const { userId, registrationId } = await runner();
      const conn = await h.connections.findOneByOrFail({ userId });
      const insert = (over: Record<string, unknown>) =>
        h.ds.query(
          `INSERT INTO strava_activities (user_id, registration_id, strava_connection_id, kind, client_request_id, status, active_registration_key, active_file_key, strava_activity_id)
           VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
          [userId, registrationId, conn.id, over.req ?? randomUUID(), over.status ?? 'pending', over.reg ?? null, over.file ?? null, over.sid ?? null],
        );
      await insert({ reg: registrationId });
      await expect(insert({ reg: registrationId })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      await insert({ status: 'failed' }); // NULL keys: any number of failed rows may coexist
      await insert({ status: 'failed' });
      await insert({ sid: '555' });
      await expect(insert({ sid: '555' })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      await expect(insert({ req: 'same' }).then(() => insert({ req: 'same' }))).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    });

    it('one connection per user and one user per Strava athlete are enforced by unique indexes', async () => {
      const a = await h.seedUser();
      const b = await h.seedUser();
      await h.seedConnection(a, { athleteId: '777' });
      await expect(h.seedConnection(b, { athleteId: '777' })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      await expect(h.seedConnection(a, { athleteId: '888' })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    });

    it('Strava rows cascade with their parents (registration -> activities, user -> connection)', async () => {
      const { userId, registrationId } = await runner();
      h.client.createActivity.mockResolvedValue({ id: 1 });
      await h.activities.createManual(userId, manual(registrationId));
      expect(await h.records.count()).toBe(1);
      await h.ds.query('DELETE FROM registrations WHERE id = ?', [registrationId]);
      expect(await h.records.count()).toBe(0);
      expect(await h.connections.count()).toBe(1); // the connection outlives a single registration

      // (Existing schema already blocks deleting users who have registrations; that is unchanged.)
      await h.ds.query('DELETE FROM users WHERE id = ?', [userId]);
      expect(await h.connections.count()).toBe(0);
    });
  });
});
