import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

// Each category has its own full route now — there is no single event-level route anymore.
export class SetCategoryRouteDto {
  // Optional: a category can be routed with drawn coordinates instead.
  // require_tld: false lets http://localhost:3000/... upload URLs pass in dev.
  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;

  // [lng, lat] pairs. Per-point shape is checked in EventsService.setCategoryRoute
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