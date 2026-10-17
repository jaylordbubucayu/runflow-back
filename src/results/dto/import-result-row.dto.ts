import { IsNumber, IsOptional, IsString } from 'class-validator';

export class ImportResultRowDto {
  @IsString()
  registrationId: string;

  @IsOptional()
  @IsString()
  officialTime?: string;

  @IsOptional()
  @IsString()
  gunTime?: string;

  @IsOptional()
  @IsString()
  chipTime?: string;

  @IsOptional()
  @IsString()
  pacePerKm?: string;

  @IsNumber()
  distanceKm: number;

  @IsOptional()
  @IsNumber()
  overallRank?: number;

  @IsOptional()
  @IsNumber()
  categoryRank?: number;

  @IsOptional()
  @IsNumber()
  ageGroupRank?: number;
}
