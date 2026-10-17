import { Test, TestingModule } from '@nestjs/testing';
import { PaymentWebhookController } from './payments-webhook.controller';

describe('PaymentsWebhookController', () => {
  let controller: PaymentWebhookController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
    }).compile();

    controller = module.get<PaymentWebhookController>(PaymentWebhookController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
