import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(255)
  email: string;
}

export class VerifyResetOtpDto {
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'otp must be a 6-digit code' })
  otp: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  @MaxLength(128)
  resetToken: string;

  // ADAPT: keep identical to RegisterDto / ChangePasswordDto and the frontend checklist.
  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt only uses the first 72 bytes
  @Matches(/[A-Z]/, { message: 'newPassword must contain an uppercase letter' })
  @Matches(/[a-z]/, { message: 'newPassword must contain a lowercase letter' })
  @Matches(/\d/, { message: 'newPassword must contain a number' })
  @Matches(/[^A-Za-z0-9]/, { message: 'newPassword must contain a special character' })
  newPassword: string;

  @IsString()
  @MaxLength(72)
  confirmPassword: string;
}
