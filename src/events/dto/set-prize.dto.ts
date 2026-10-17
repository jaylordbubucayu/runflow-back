import { IsNumber, IsOptional, IsString } from 'class-validator';

export class SetPrizeDto {
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsString()
  position: string;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  description?: string;
}
