import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SetPlaceDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  overallRank?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  categoryRank?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  ageGroupRank?: number;
}

// For the batch endpoint
export class SetPlaceByBibRowDto extends SetPlaceDto {
  @IsString()
  bibNumber: string;
}