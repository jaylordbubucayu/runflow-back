import { dayDiff, eventHasStarted, localDateInZone, nowLocalIso, normalizeDateOnly, wallClockToDate, dateToWallClock } from './strava-dates';

describe('strava-dates', () => {
  const TZ = 'Asia/Manila'; // UTC+8, no DST

  it('converts an instant to the event-zone calendar date', () => {
    // 2026-10-10 20:00Z is already 2026-10-11 04:00 in Manila
    expect(localDateInZone(new Date('2026-10-10T20:00:00Z'), TZ)).toBe('2026-10-11');
    expect(localDateInZone(new Date('2026-10-10T15:59:00Z'), TZ)).toBe('2026-10-10');
  });

  it('treats an event happening today as started (same-day uploads)', () => {
    const now = new Date('2026-10-10T20:00:00Z'); // 2026-10-11 in Manila
    expect(eventHasStarted('2026-10-11', TZ, now)).toBe(true);
    expect(eventHasStarted('2026-10-12', TZ, now)).toBe(false);
    expect(eventHasStarted('2026-10-01', TZ, now)).toBe(true);
  });

  it('produces a lexicographically comparable local timestamp', () => {
    expect(nowLocalIso(TZ, new Date('2026-10-10T20:05:09Z'))).toBe('2026-10-11T04:05:09');
  });

  it('normalises date-only values and computes day differences', () => {
    expect(normalizeDateOnly('2026-10-11')).toBe('2026-10-11');
    expect(normalizeDateOnly('2026-10-11T00:00:00.000Z')).toBe('2026-10-11');
    expect(dayDiff('2026-10-12', '2026-10-11')).toBe(1);
    expect(dayDiff('2026-10-09', '2026-10-11')).toBe(-2);
    expect(dayDiff('2026-03-01', '2026-02-28')).toBe(1);
  });

  it('round-trips wall-clock text regardless of server zone', () => {
    const d = wallClockToDate('2026-10-11T05:30:00');
    expect(dateToWallClock(d)).toBe('2026-10-11T05:30:00');
    expect(dateToWallClock(wallClockToDate('2026-10-11T05:30'))).toBe('2026-10-11T05:30:00');
    expect(dateToWallClock(null)).toBeNull();
  });
});
