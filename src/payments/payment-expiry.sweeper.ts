import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentSettlementService } from './payment-settlement.service';

/**
 * Periodically expires payment links past their timeout (PayMongo links never expire on their
 * own) and frees the slots they were holding. Dependency-free (a plain interval, no scheduler
 * package). Safe with several app instances: every step is idempotent and row-locked.
 * Set PAYMENT_EXPIRY_SWEEP_SECONDS=0 to disable.
 */
@Injectable()
export class PaymentExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentExpirySweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly settlement: PaymentSettlementService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const seconds = Number(this.config.get('PAYMENT_EXPIRY_SWEEP_SECONDS') ?? 300);
    if (!seconds || this.config.get('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      this.settlement
        .expireStale()
        .then((n) => n && this.logger.log(`Expired ${n} stale payment link(s)`))
        .catch((err) => this.logger.warn(`Expiry sweep failed: ${err?.message}`));
    }, seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
