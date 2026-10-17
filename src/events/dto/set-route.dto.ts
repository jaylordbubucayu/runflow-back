import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

export class SetRouteDto {
  // Optional: an event can be routed with drawn coordinates instead.
  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  // [lng, lat] pairs. Per-point shape is checked in EventsService.setRoute
  // (class-validator has no built-in tuple validator).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20000)
  routeCoordinates?: number[][];

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  distanceKm: number;

  @IsOptional()
  @IsNumber()
  elevationM?: number;
}
