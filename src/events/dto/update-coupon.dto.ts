import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateCouponDto } from './create-coupon.dto';

export class UpdateCouponDto extends PartialType(CreateCouponDto) {
  // The main lever organizers will actually use day-to-day: pause a coupon without deleting it
  // (deleting would null out coupon_id on every registration that already redeemed it).
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
