import { Test, TestingModule } from '@nestjs/testing';
import { PaymentWebhookService } from './payments-webhook.service';


describe('PaymentsWebhookService', () => {
  let service: PaymentWebhookService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentWebhookService],
    }).compile();

    service = module.get<PaymentWebhookService>(PaymentWebhookService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
