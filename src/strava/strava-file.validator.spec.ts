import { fitCrc, validateActivityFile, UploadedFileLike } from './strava-file.validator';

const MAX = 1024 * 1024;

/** Builds a structurally valid FIT file (header + payload + CRC) with the SDK's own CRC. */
function makeFit(payloadBytes = 32, headerSize: 12 | 14 = 14): Buffer {
  const header = Buffer.alloc(headerSize);
  header[0] = headerSize;
  header[1] = 0x20; // protocol
  header.writeUInt16LE(2100, 2); // profile
  header.writeUInt32LE(payloadBytes, 4);
  header.write('.FIT', 8, 'ascii');
  const body = Buffer.alloc(payloadBytes, 1);
  const withoutCrc = Buffer.concat([header, body]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(fitCrc(withoutCrc));
  return Buffer.concat([withoutCrc, crc]);
}

const file = (name: string, buf: Buffer | string, mimetype = 'application/octet-stream'): UploadedFileLike => {
  const buffer = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return { originalname: name, mimetype, size: buffer.length, buffer };
};

const GPX = (time = '2026-10-11T05:30:00Z') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="t"><metadata><time>2026-10-12T00:00:00Z</time></metadata><trk><trkseg>` +
  `<trkpt lat="16.4" lon="120.6"><ele>1500</ele><time>${time}</time></trkpt></trkseg></trk></gpx>`;
const TCX = (time = '2026-10-11T05:30:00Z') =>
  `<?xml version="1.0"?><TrainingCenterDatabase xmlns="x"><Activities><Activity Sport="Running"><Id>2026-10-11T05:30:00Z</Id><Lap StartTime="${time}"><Track>` +
  `<Trackpoint><Time>${time}</Time></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`;

const code = (fn: () => unknown) => {
  try { fn(); } catch (e: any) { return { status: e.getStatus?.(), error: e.getResponse?.().error, message: e.getResponse?.().message }; }
  return null;
};

describe('validateActivityFile', () => {
  describe('FIT', () => {
    it('accepts a valid FIT (12- and 14-byte headers) and hashes it', () => {
      for (const h of [12, 14] as const) {
        const buf = makeFit(40, h);
        const v = validateActivityFile(file('run.FIT', buf), MAX);
        expect(v.type).toBe('fit');
        expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(v.startInstant).toBeNull();
      }
    });
    it('rejects a flipped byte (CRC mismatch)', () => {
      const buf = makeFit();
      buf[20] ^= 0xff;
      expect(code(() => validateActivityFile(file('a.fit', buf), MAX))?.message).toMatch(/integrity/);
    });
    it('rejects truncated files, bad signature and tiny files', () => {
      expect(code(() => validateActivityFile(file('a.fit', makeFit().subarray(0, 30)), MAX))?.message).toMatch(/truncated/);
      const sig = makeFit(); sig.write('.XXX', 8, 'ascii');
      expect(code(() => validateActivityFile(file('a.fit', sig), MAX))?.message).toMatch(/signature/);
      expect(code(() => validateActivityFile(file('a.fit', Buffer.from([1, 2, 3])), MAX))?.error).toBe('STRAVA_INVALID_FILE');
    });
    it('rejects a text file renamed to .fit', () => {
      expect(code(() => validateActivityFile(file('a.fit', 'hello world, definitely not fit'), MAX))?.error).toBe('STRAVA_INVALID_FILE');
    });
    it('matches the published CRC test vector behaviour (CRC of data+its CRC is 0)', () => {
      const buf = makeFit(10);
      expect(fitCrc(buf)).toBe(0);
    });
  });

  describe('GPX', () => {
    it('accepts valid GPX and reads the first TRACKPOINT time (not metadata time)', () => {
      const v = validateActivityFile(file('r.gpx', GPX(), 'application/gpx+xml'), MAX);
      expect(v.type).toBe('gpx');
      expect(v.startInstant?.toISOString()).toBe('2026-10-11T05:30:00.000Z');
    });
    it('rejects missing trackpoints / timestamps / root', () => {
      expect(code(() => validateActivityFile(file('r.gpx', '<gpx></gpx>', 'text/xml'), MAX))?.message).toMatch(/no recorded track points/);
      expect(code(() => validateActivityFile(file('r.gpx', GPX().replace(/<time>[^<]*<\/time><\/trkpt>/, '</trkpt>'), 'text/xml'), MAX))?.message).toMatch(/no timestamps/);
      expect(code(() => validateActivityFile(file('r.gpx', '<html></html>', 'text/xml'), MAX))?.message).toMatch(/valid GPX/);
    });
    it('rejects DOCTYPE/ENTITY payloads (XXE / entity expansion)', () => {
      const evil = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]>` + GPX().replace(/^<\?xml[^>]*\?>\n/, '');
      expect(code(() => validateActivityFile(file('r.gpx', evil, 'text/xml'), MAX))?.message).toMatch(/unsupported XML/);
    });
    it('rejects NUL bytes', () => {
      expect(code(() => validateActivityFile(file('r.gpx', Buffer.concat([Buffer.from(GPX()), Buffer.from([0])]), 'text/xml'), MAX))?.error).toBe('STRAVA_INVALID_FILE');
    });
  });

  describe('TCX', () => {
    it('accepts valid TCX', () => {
      const v = validateActivityFile(file('r.tcx', TCX(), 'application/vnd.garmin.tcx+xml'), MAX);
      expect(v.type).toBe('tcx');
      expect(v.startInstant?.toISOString()).toBe('2026-10-11T05:30:00.000Z');
    });
    it('rejects non-TCX XML and a GPX renamed to .tcx', () => {
      expect(code(() => validateActivityFile(file('r.tcx', GPX(), 'text/xml'), MAX))?.message).toMatch(/valid TCX/);
    });
  });

  describe('generic guards', () => {
    it('rejects missing file, empty file, unknown extension', () => {
      expect(code(() => validateActivityFile(undefined, MAX))?.status).toBe(400);
      expect(code(() => validateActivityFile(file('a.gpx', ''), MAX))?.message).toMatch(/empty/);
      expect(code(() => validateActivityFile(file('a.exe', 'MZ'), MAX))?.message).toMatch(/Only \.fit/);
      expect(code(() => validateActivityFile(file('noextension', 'x'), MAX))?.message).toMatch(/Only \.fit/);
    });
    it('rejects oversize files with 413, even if the declared size lies', () => {
      const big = Buffer.alloc(2048, 'a');
      expect(code(() => validateActivityFile(file('a.gpx', big), 1024))?.status).toBe(413);
      expect(code(() => validateActivityFile({ ...file('a.gpx', big, 'text/xml'), size: 1 }, 1024))?.status).toBe(413);
    });
    it('rejects a MIME type that contradicts the extension (e.g. an image named .gpx)', () => {
      expect(code(() => validateActivityFile(file('a.gpx', GPX(), 'image/png'), MAX))?.message).toMatch(/does not match/);
      expect(code(() => validateActivityFile(file('a.fit', makeFit(), 'text/html'), MAX))?.message).toMatch(/does not match/);
    });
    it('ignores MIME parameters and case', () => {
      expect(validateActivityFile(file('a.GPX', GPX(), 'Application/XML; charset=utf-8'), MAX).type).toBe('gpx');
    });
    it('produces a stable hash for identical content', () => {
      const a = validateActivityFile(file('a.gpx', GPX(), 'text/xml'), MAX).sha256;
      const b = validateActivityFile(file('other-name.gpx', GPX(), 'text/xml'), MAX).sha256;
      expect(a).toBe(b);
    });
  });
});
