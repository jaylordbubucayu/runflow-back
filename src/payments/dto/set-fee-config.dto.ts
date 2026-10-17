import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { FeeType } from '../../common/enums';

export class SetFeeConfigDto {
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsEnum(FeeType)
  feeType: FeeType;

  @IsOptional()
  @IsNumber()
  fixedAmount?: number;

  @IsOptional()
  @IsNumber()
  percentage?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsDateString()
  effectiveFrom: string;
}
