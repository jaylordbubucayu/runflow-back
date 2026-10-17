import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { EMAIL_OPTIONS } from './email.constants'
import { EmailModuleOptions, ResolvedMessage, SendResult } from './interfaces/email.interfaces';
import { EmailLog, EmailStatus } from './entities/email.entity';

/**
 * All methods are fail-safe: a DB problem is logged but NEVER blocks or fails an email send.
 */
@Injectable()
export class EmailLogService {
  private readonly logger = new Logger(EmailLogService.name);

  constructor(
    @Inject(EMAIL_OPTIONS) private readonly opts: EmailModuleOptions,
    @InjectRepository(EmailLog) private readonly repo: Repository<EmailLog>,
  ) {}

  private get enabled() {
    return this.opts.persistence?.enabled !== false;
  }

  async start(
    msg: ResolvedMessage,
    ctx: { provider: string; template?: string; metadata?: Record<string, unknown> },
  ): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const body = msg.html ?? msg.text ?? '';
      const row = await this.repo.save(
        this.repo.create({
          status: EmailStatus.PENDING,
          provider: ctx.provider,
          from: msg.from,
          to: msg.to,
          cc: msg.cc ?? null,
          bcc: msg.bcc ?? null,
          subject: msg.subject,
          template: ctx.template ?? null,
          bodyHash: createHash('sha256').update(body).digest('hex'),
          body: this.opts.persistence?.storeBody ? body : null,
          attachmentCount: msg.attachments?.length ?? 0,
          metadata: ctx.metadata ?? null,
        }),
      );
      return row.id;
    } catch (e) {
      this.logger.error(`Could not create email log: ${(e as Error).message}`);
      return null;
    }
  }

  markSent(id: string | null, res: SendResult, attempts: number) {
    return this.update(id, {
      status: EmailStatus.SENT,
      messageId: res.messageId,
      accepted: res.accepted,
      rejected: res.rejected,
      attempts,
      sentAt: new Date(),
    });
  }

  markFailed(id: string | null, err: unknown, attempts: number) {
    return this.update(id, {
      status: EmailStatus.FAILED,
      attempts,
      error: String((err as Error)?.message ?? err).slice(0, 500),
    });
  }

  markDryRun(id: string | null) {
    return this.update(id, { status: EmailStatus.DRY_RUN, messageId: 'dry-run' });
  }

  private async update(id: string | null, patch: Partial<EmailLog>) {
    if (!id) return;
    try {
      await this.repo.update(id, patch as any);
    } catch (e) {
      this.logger.error(`Could not update email log ${id}: ${(e as Error).message}`);
    }
  }
}