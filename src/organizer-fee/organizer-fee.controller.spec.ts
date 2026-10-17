import { Test, TestingModule } from '@nestjs/testing';
import { OrganizerFeeController } from './organizer-fee.controller';
import { OrganizerFeeService } from './organizer-fee.service';

describe('OrganizerFeeController', () => {
  let controller: OrganizerFeeController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizerFeeController],
      providers: [OrganizerFeeService],
    }).compile();

    controller = module.get<OrganizerFeeController>(OrganizerFeeController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
