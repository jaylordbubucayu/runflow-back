import { DynamicModule, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EMAIL_OPTIONS, EMAIL_PROVIDER } from './email.constants';
import { EmailLogService } from './email-log.service';
import { EmailModuleAsyncOptions, EmailModuleOptions } from './interfaces/email.interfaces';
import { EmailService } from './email.service';
import { EmailLog } from './entities/email.entity';
import { SmtpProvider } from './providers/smtp.provider';
import { TemplateService } from './templates/template.service';

const providerFactory = {
  provide: EMAIL_PROVIDER,
  inject: [EMAIL_OPTIONS],
  useFactory: (opts: EmailModuleOptions) => {
    if (opts.provider) return opts.provider;
    if (opts.smtp) return new SmtpProvider(opts.smtp);
    throw new Error('EmailModule: supply either `smtp` or `provider`');
  },
};

const shared = [providerFactory, TemplateService, EmailLogService, EmailService];

@Global()
@Module({})
export class EmailModule {
  static forRoot(options: EmailModuleOptions): DynamicModule {
    return {
      module: EmailModule,
      imports: [TypeOrmModule.forFeature([EmailLog])],
      providers: [{ provide: EMAIL_OPTIONS, useValue: options }, ...shared],
      exports: [EmailService],
    };
  }

  static forRootAsync(options: EmailModuleAsyncOptions): DynamicModule {
    return {
      module: EmailModule,
      imports: [...(options.imports ?? []), TypeOrmModule.forFeature([EmailLog])],
      providers: [
        { provide: EMAIL_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        ...shared,
      ],
      exports: [EmailService],
    };
  }
}