import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { Gender } from '../../common/enums';

export class CreateRegistrationDto {
  @IsString()
  categoryId: string;

  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsDateString()
  birthday: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsString()
  mobileNumber: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsString()
  emergencyContactName: string;

  @IsString()
  emergencyContactNumber: string;

  @IsOptional()
  @IsString()
  shirtSize?: string;

  @IsOptional()
  @IsString()
  couponCode?: string;
}
