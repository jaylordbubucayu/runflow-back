import { IsString } from 'class-validator';

export class CheckInDto {
  @IsString()
  registrationId: string;
}
