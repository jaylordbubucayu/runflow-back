import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { PaymentWebhookService } from './payments-webhook.service';

/**
 * POST /api/webhooks/paymongo — called by PayMongo, not by browsers, so no JWT guard. Trust comes
 * from the signature, verified over the raw body (main.ts enables `rawBody`).
 */
@Controller('webhooks')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post('paymongo')
  @HttpCode(200)
  handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('paymongo-signature') signature?: string,
  ) {
    return this.webhooks.handle(req.rawBody, signature);
  }
}