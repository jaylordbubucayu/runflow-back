import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

export class CreateEventDto {
  @IsString()
  name: string;

  // require_tld:false so local/dev asset hosts (http://localhost:…) validate.
  @IsOptional()
  @IsUrl({ require_tld: false })
  bannerUrl?: string;

  // URLs returned by POST /uploads/images. Capped at 3 to match the upload endpoint's own limit
  // (enforced again here since a client could otherwise send an arbitrary array directly).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsUrl({ require_tld: false }, { each: true })
  bannerUrls?: string[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  eventDate: string;

  @IsDateString()
  registrationStart: string;

  @IsDateString()
  registrationEnd: string;

  @IsString()
  venue: string;

  @IsString()
  location: string;

  @IsOptional()
  @IsString()
  assemblyTime?: string;

  @IsOptional()
  @IsString()
  startingTime?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;
}