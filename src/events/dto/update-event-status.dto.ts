import { IsEnum } from 'class-validator';
import { EventStatus } from '../../common/enums';

export class UpdateEventStatusDto {
  @IsEnum(EventStatus)
  status: EventStatus;
}