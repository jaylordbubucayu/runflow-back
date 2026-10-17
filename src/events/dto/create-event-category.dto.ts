import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { GenderRestriction } from '../../common/enums';

export class CreateEventCategoryDto {
  @IsString()
  name: string;

  @IsNumber()
  distanceKm: number;

  @IsNumber()
  @Min(0)
  price: number;

  @IsInt()
  @Min(1)
  slotsTotal: number;

  @IsOptional()
  @IsInt()
  minAge?: number;

  @IsOptional()
  @IsInt()
  maxAge?: number;

  @IsOptional()
  @IsEnum(GenderRestriction)
  genderRestriction?: GenderRestriction;

}