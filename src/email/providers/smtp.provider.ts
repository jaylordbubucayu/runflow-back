import * as nodemailer from 'nodemailer';
import { EmailProvider, ResolvedMessage, SendResult, SmtpOptions } from '../interfaces/email.interfaces';

export class SmtpProvider implements EmailProvider {
  private readonly transporter: nodemailer.Transporter;

  constructor(opts: SmtpOptions) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure ?? opts.port === 465,
      requireTLS: !(opts.secure ?? opts.port === 465), // force STARTTLS, no plaintext fallback
      auth: { user: opts.user, pass: opts.pass },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      pool: true,
      maxConnections: 5,
    });
  }

  async send(msg: ResolvedMessage): Promise<SendResult> {
    const info = await this.transporter.sendMail(msg);
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }

  async verify(): Promise<boolean> {
    return !!(await this.transporter.verify());
  }
}