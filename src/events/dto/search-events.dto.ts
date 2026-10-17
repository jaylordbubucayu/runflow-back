import { IsOptional, IsString } from 'class-validator';

export class SearchEventsDto {
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  distanceKm?: string;

  @IsOptional()
  @IsString()
  priceType?: 'free' | 'paid';
}
