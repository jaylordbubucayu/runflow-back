import { createHash } from 'crypto';
import { stravaError } from './strava.errors';
import { StravaErrorCode } from './strava.constants';

export type ActivityFileType = 'fit' | 'tcx' | 'gpx';

export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ValidatedActivityFile {
  type: ActivityFileType;
  sha256: string;
  size: number;
  /** First recorded timestamp (GPX/TCX only; null for FIT which we don't fully decode). */
  startInstant: Date | null;
}

const MIME: Record<ActivityFileType, string[]> = {
  // Browsers/OSes label these inconsistently; MIME is a weak hint, content sniffing decides.
  gpx: ['application/gpx+xml', 'application/xml', 'text/xml', 'application/octet-stream'],
  tcx: ['application/vnd.garmin.tcx+xml', 'application/xml', 'text/xml', 'application/octet-stream'],
  fit: ['application/octet-stream', 'application/fit', 'application/vnd.ant.fit', 'application/x-fit'],
};

const bad = (message: string) => stravaError(400, StravaErrorCode.INVALID_FILE, message);

/** FIT SDK CRC-16 (nibble table). */
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4401];
export function fitCrc(buf: Buffer, start = 0, end = buf.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = buf[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

function validateFit(buf: Buffer): void {
  if (buf.length < 14) throw bad('This does not look like a valid FIT file (too small).');
  const headerSize = buf[0];
  if (headerSize !== 12 && headerSize !== 14) throw bad('This does not look like a valid FIT file (bad header).');
  if (buf.toString('ascii', 8, 12) !== '.FIT') throw bad('This does not look like a valid FIT file (missing signature).');
  const dataSize = buf.readUInt32LE(4);
  const total = headerSize + dataSize + 2;
  if (dataSize === 0 || total > buf.length) throw bad('This FIT file looks truncated or corrupted.');
  // File CRC covers header + data and is stored in the 2 bytes after them.
  if (fitCrc(buf, 0, total - 2) !== buf.readUInt16LE(total - 2)) throw bad('This FIT file failed its integrity check (CRC mismatch).');
}

function decodeXml(buf: Buffer, label: string): string {
  if (buf.includes(0)) throw bad(`This does not look like a valid ${label} file.`);
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  // We never feed uploads to an XML parser, but refuse DTD/entity tricks outright anyway.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw bad(`This ${label} file contains unsupported XML declarations.`);
  return text;
}

function firstTimeAfter(text: string, marker: RegExp, tag: 'time' | 'Time'): Date | null {
  const at = text.search(marker);
  if (at < 0) return null;
  const m = new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(text.slice(at));
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validateGpx(buf: Buffer): Date | null {
  const t = decodeXml(buf, 'GPX');
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<gpx[\s>]/.test(t) || !/<\/gpx>\s*$/.test(t)) throw bad('This does not look like a valid GPX file.');
  if (!/<trkpt[\s>]/.test(t)) throw bad('This GPX file has no recorded track points.');
  const start = firstTimeAfter(t, /<trkpt[\s>]/, 'time');
  if (!start) throw bad('This GPX file has no timestamps, so Strava cannot place the activity in time.');
  return start;
}

function validateTcx(buf: Buffer): Date | null {
  const t = decodeXml(buf, 'TCX');
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<TrainingCenterDatabase[\s>]/.test(t) || !/<\/TrainingCenterDatabase>\s*$/.test(t)) {
    throw bad('This does not look like a valid TCX file.');
  }
  if (!/<Trackpoint[\s>]/.test(t)) throw bad('This TCX file has no recorded track points.');
  const start = firstTimeAfter(t, /<Trackpoint[\s>]/, 'Time');
  if (!start) throw bad('This TCX file has no timestamps.');
  return start;
}

export function validateActivityFile(file: UploadedFileLike | undefined, maxBytes: number): ValidatedActivityFile {
  if (!file || !file.buffer) throw bad('Choose a .fit, .tcx or .gpx file to upload.');
  if (file.size > maxBytes || file.buffer.length > maxBytes) {
    throw stravaError(413, StravaErrorCode.INVALID_FILE, `That file is too large (limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
  }
  if (file.buffer.length === 0) throw bad('That file is empty.');

  const ext = /\.([A-Za-z0-9]+)$/.exec(file.originalname ?? '')?.[1]?.toLowerCase();
  if (ext !== 'fit' && ext !== 'tcx' && ext !== 'gpx') throw bad('Only .fit, .tcx and .gpx files are supported.');
  const mime = (file.mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (!MIME[ext].includes(mime)) throw bad(`That file type (${mime || 'unknown'}) does not match a .${ext} file.`);

  let startInstant: Date | null = null;
  if (ext === 'fit') validateFit(file.buffer);
  else if (ext === 'gpx') startInstant = validateGpx(file.buffer);
  else startInstant = validateTcx(file.buffer);

  return { type: ext, size: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex'), startInstant };
}

