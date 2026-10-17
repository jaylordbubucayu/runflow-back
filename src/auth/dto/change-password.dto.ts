import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Keep the password rules identical to RegisterDto (and to the rules shown on the frontend page).
 * ADAPT: if RegisterDto uses a different policy, copy its decorators here.
 * MaxLength(72): bcrypt only uses the first 72 bytes of a password.
 */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/[A-Z]/, { message: 'newPassword must contain an uppercase letter' })
  @Matches(/[a-z]/, { message: 'newPassword must contain a lowercase letter' })
  @Matches(/\d/, { message: 'newPassword must contain a number' })
  @Matches(/[^A-Za-z0-9]/, { message: 'newPassword must contain a special character' })
  newPassword: string;

  // The frontend sends it, and the DTO uses whitelist + forbidNonWhitelisted, so it must be declared.
  @IsString()
  @MaxLength(72)
  confirmPassword: string;
}