import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { EMAIL_OPTIONS, EMAIL_PROVIDER } from './email.constants';
import {
  EmailModuleOptions, EmailProvider, ResolvedMessage,
  SendEmailInput, SendResult, SendTemplateInput,
} from './interfaces/email.interfaces';
import { TemplateService } from './templates/template.service';
import { EmailLogService } from './email-log.service';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_OPTIONS) private readonly opts: EmailModuleOptions,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    private readonly templates: TemplateService,
    private readonly logs: EmailLogService,
  ) {}

  async send(input: SendEmailInput): Promise<SendResult> {
    return this.dispatch(input);
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const { template, context, ...rest } = input;
    const { html, text } = this.templates.render(template, context);
    return this.dispatch({ ...rest, html, text }, template);
  }

  private async dispatch(input: SendEmailInput, template?: string): Promise<SendResult> {
    const msg = this.build(input); // invalid input throws here, before anything is logged or sent
    const logId = await this.logs.start(msg, {
      provider: this.opts.provider ? this.opts.provider.constructor.name : 'smtp',
      template,
      metadata: input.metadata,
    });

    if (this.opts.dryRun) {
      this.logger.log(`[dryRun] to=${msg.to.map(this.mask).join(',')} subject="${msg.subject}"`);
      await this.logs.markDryRun(logId);
      return { messageId: 'dry-run', accepted: msg.to, rejected: [] };
    }

    const attempts = (this.opts.retries ?? 2) + 1;
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await this.provider.send(msg);
        this.logger.log(`Sent ${res.messageId} to ${msg.to.map(this.mask).join(',')}`);
        await this.logs.markSent(logId, res, i);
        return res;
      } catch (err) {
        lastErr = err;
        this.logger.warn(`Send attempt ${i}/${attempts} failed: ${(err as Error).message}`);
        if (i < attempts) await new Promise((r) => setTimeout(r, 2 ** i * 500)); // backoff
      }
    }
    await this.logs.markFailed(logId, lastErr, attempts);
    // Never leak provider internals to API callers
    this.logger.error('Email delivery failed', (lastErr as Error)?.stack);
    throw new Error('Email delivery failed');
  }

  // ---------- validation / hardening ----------

  private build(i: SendEmailInput): ResolvedMessage {
    const to = this.addrs(i.to, 'to');
    const cc = i.cc ? this.addrs(i.cc, 'cc') : undefined;
    const bcc = i.bcc ? this.addrs(i.bcc, 'bcc') : undefined;

    const total = to.length + (cc?.length ?? 0) + (bcc?.length ?? 0);
    if (total === 0 || total > (this.opts.maxRecipients ?? 50)) {
      throw new BadRequestException('Invalid recipient count');
    }
    if (!i.html && !i.text) throw new BadRequestException('Email body is empty');

    const subject = this.noCrlf(i.subject).slice(0, 200);
    if (!subject) throw new BadRequestException('Subject is required');

    const max = this.opts.maxAttachmentBytes ?? 5 * 1024 * 1024;
    const size = (i.attachments ?? []).reduce((n, a) => n + Buffer.byteLength(a.content), 0);
    if (size > max) throw new BadRequestException('Attachments too large');

    return {
      from: this.single(i.from ?? this.opts.defaultFrom, 'from'),
      to, cc, bcc,
      replyTo: i.replyTo ? this.single(i.replyTo, 'replyTo') : undefined,
      subject,
      html: i.html,
      text: i.text,
      attachments: i.attachments?.map((a) => ({ ...a, filename: this.noCrlf(a.filename).replace(/[\\/]/g, '_') })),
    };
  }

  /** Header-injection defense: reject any CR/LF in header-bound values. */
  private noCrlf(v: string): string {
    return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  }

  private single(v: string, field: string): string {
    if (/[\r\n]/.test(v)) throw new BadRequestException(`Invalid ${field}`);
    // allow "Name <a@b.com>" for from/replyTo
    const m = v.match(/<([^>]+)>$/);
    this.assertEmail(m ? m[1] : v, field);
    return v.trim();
  }

  private addrs(v: string | string[], field: string): string[] {
    const list = (Array.isArray(v) ? v : [v]).map((a) => a.trim().toLowerCase());
    list.forEach((a) => this.assertEmail(a, field));
    return [...new Set(list)];
  }

  private assertEmail(a: string, field: string) {
    if (a.length > 254 || !EMAIL_RE.test(a)) throw new BadRequestException(`Invalid email in ${field}`);
   const allow = this.opts.allowedRecipientDomains;
    if (allow?.length && field !== 'from' && field !== 'replyTo') {
      if (!allow.includes(a.split('@')[1].toLowerCase())) {
        throw new BadRequestException(`Recipient domain not allowed`);
      }
    }
  }

  private mask = (a: string) => a.replace(/^(.).*(@.*)$/, '$1***$2'); // PII-safe logs
}