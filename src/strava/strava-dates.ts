/** Calendar-date helpers. Event dates are plain 'YYYY-MM-DD' (no zone); we compare in one configured zone. */

export function localDateInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 'YYYY-MM-DDTHH:mm:ss' wall-clock in `tz` (lexicographically comparable). */
export function nowLocalIso(tz: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
}

export function normalizeDateOnly(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayDiff(a: string, b: string): number {
  const ms = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((ms(a) - ms(b)) / 86_400_000);
}

/** Has the event day begun (in `tz`)? An event "today" counts, so same-day race uploads work. */
export function eventHasStarted(eventDate: string, tz: string, now = new Date()): boolean {
  return localDateInZone(now, tz) >= eventDate;
}

/** Local wall-clock text <-> Date, kept consistent regardless of the server's zone. */
export function wallClockToDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) throw new Error('bad wall-clock');
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

export function dateToWallClock(d: Date | null): string | null {
  if (!d) return null;
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
