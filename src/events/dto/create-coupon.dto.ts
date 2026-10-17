import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CouponDiscountType } from '../../common/enums';

export class CreateCouponDto {
  // Uppercase-normalized in the service before saving, so "earlybird" and "EARLYBIRD" are the
  // same code — the validator just checks shape here.
  @IsString()
  @Length(3, 32)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'code may only contain letters, numbers, hyphens and underscores',
  })
  code: string;

  @IsEnum(CouponDiscountType)
  discountType: CouponDiscountType;

  // Percentage: 0-100. Fixed: any positive peso amount (not bounded here — validated against the
  // category price at redemption time instead, where a too-large fixed discount is simply capped
  // at the price rather than producing a negative total).
  @IsNumber()
  @Min(0)
  @Max(100000)
  discountValue: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsesPerUser?: number;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;
}
