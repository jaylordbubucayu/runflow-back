import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SELF_SERVE_ROLES } from '../google.constants';

/** Declares EVERY accepted query param: the global ValidationPipe uses forbidNonWhitelisted. */
export class GoogleStartQueryDto {
  /** Only used when this sign-in creates a brand-new account. `admin` is rejected here (400). */
  @IsOptional() @IsIn(SELF_SERVE_ROLES as unknown as string[])
  role?: string;

  @IsOptional() @IsString() @MaxLength(255)
  redirect?: string;
}

export class GoogleExchangeDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'Invalid code' })
  code: string;
}
