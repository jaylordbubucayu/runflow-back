import { Test, TestingModule } from '@nestjs/testing';
import { OrganizerFeeService } from './organizer-fee.service';

describe('OrganizerFeeService', () => {
  let service: OrganizerFeeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OrganizerFeeService],
    }).compile();

    service = module.get<OrganizerFeeService>(OrganizerFeeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
