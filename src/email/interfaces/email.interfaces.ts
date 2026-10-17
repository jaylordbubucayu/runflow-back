import { ModuleMetadata } from '@nestjs/common';

export interface EmailAttachment {
  filename: string;
  /** In-memory content only. File paths/URLs are deliberately NOT supported (prevents local file read / SSRF). */
  content: Buffer | string;
  contentType?: string;
}

export interface SendEmailInput {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** Stored with the log row (e.g. { userId, reason: 'password-reset' }). Never put secrets here. */
  metadata?: Record<string, unknown>;
}

export interface SendTemplateInput extends Omit<SendEmailInput, 'html' | 'text'> {
  template: string; // file name without extension, e.g. "welcome"
  context?: Record<string, unknown>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

/** Implement this to add SES, SendGrid, Mailgun, etc. without touching EmailService. */
export interface EmailProvider {
  send(message: ResolvedMessage): Promise<SendResult>;
  verify?(): Promise<boolean>;
}

export interface ResolvedMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
}

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** true = implicit TLS (465). false = STARTTLS is enforced (587). Plaintext is never allowed. */
  secure?: boolean;
}

export interface EmailModuleOptions {
  defaultFrom: string;
  /** Use built-in SMTP... */
  smtp?: SmtpOptions;
  /** ...or supply any custom provider instance. */
  provider?: EmailProvider;
  templatesDir?: string;
  /** If set, recipients outside these domains are rejected (great for staging environments). */
  allowedRecipientDomains?: string[];
  maxRecipients?: number; // default 50
  maxAttachmentBytes?: number; // default 5 MB total
  retries?: number; // default 2
  /** Log and skip sending (dev/test). */
  dryRun?: boolean;
  persistence?: {
    /** Save every transaction to the DB. Default true. */
    enabled?: boolean;
    /** Also store the rendered body. Default false (bodies often contain tokens/PII). */
    storeBody?: boolean;
  };
}

export interface EmailModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory: (...args: any[]) => Promise<EmailModuleOptions> | EmailModuleOptions;
}