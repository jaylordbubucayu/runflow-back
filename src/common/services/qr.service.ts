import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Generates and verifies HMAC-signed QR tokens.
 * We never encode the raw registration id directly (§4.2 of the arch doc) -
 * a photographed QR code should not let someone enumerate other
 * registrations by incrementing an id.
 */
@Injectable()
export class QrService {
  constructor(private readonly configService: ConfigService) {}

  private get secret(): string {
    return this.configService.get<string>('QR_SIGNING_SECRET') ?? 'dev-secret';
  }

  sign(registrationId: string): string {
    const payload = `${registrationId}.${Date.now()}`;
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('hex');
    const token = Buffer.from(`${payload}.${signature}`).toString('base64url');
    return token;
  }

  verify(token: string): { registrationId: string } | null {
    try {
      const decoded = Buffer.from(token, 'base64url').toString('utf8');
      const [registrationId, timestamp, signature] = decoded.split('.');
      const payload = `${registrationId}.${timestamp}`;
      const expected = crypto
        .createHmac('sha256', this.secret)
        .update(payload)
        .digest('hex');
      const valid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      );
      if (!valid) return null;
      return { registrationId };
    } catch {
      return null;
    }
  }
}
