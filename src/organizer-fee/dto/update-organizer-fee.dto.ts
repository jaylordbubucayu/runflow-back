import { PartialType } from '@nestjs/mapped-types';
import { CreateOrganizerFeeDto } from './create-organizer-fee.dto';

export class UpdateOrganizerFeeDto extends PartialType(CreateOrganizerFeeDto) {}
