import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { Gender } from '../../common/enums';

export class UpdateRunnerProfileDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsDateString()
  birthday?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  shirtSizeDefault?: string;
}
