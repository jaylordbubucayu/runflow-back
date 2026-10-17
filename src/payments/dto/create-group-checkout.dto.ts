import { IsString } from 'class-validator';

export class CreateGroupCheckoutDto {
  @IsString()
  groupId: string;
}