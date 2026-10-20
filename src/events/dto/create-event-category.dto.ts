import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
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

  /**
   * Time of day this category starts, 24-hour 'HH:mm' or 'HH:mm:ss'. Send null to clear it (the
   * event's own startingTime is then used). Validated here because an unparseable value would
   * otherwise surface as a database error (HTTP 500) instead of a clear 400.
   */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'startingTime must be a 24-hour time such as 06:30 or 06:30:00',
  })
  startingTime?: string | null;
}