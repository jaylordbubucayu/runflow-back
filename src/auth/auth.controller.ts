import { Body, Controller, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendEmailOtpDto, VerifyEmailOtpDto } from '../email/dto/verify-email.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ChangePasswordDto } from './dto/change-password.dto';
import { User } from 'src/users/entities/user.entity';
import { ForgotPasswordDto, ResetPasswordDto, VerifyResetOtpDto } from './dto/password-reset.dto';
import { PasswordResetService } from './password-reset.service';

@Controller('auth')
export class AuthController {
  constructor(
      private readonly authService: AuthService,
      private readonly passwordReset: PasswordResetService,
  ) {}

  /** Step 1: email a 6-digit code (also used for "Resend code"). */
  @Post('email-otp/send')
  @HttpCode(200)
  sendEmailOtp(@Body() dto: SendEmailOtpDto) {
    return this.authService.sendEmailOtp(dto);
  }

  /** Step 2: confirm the code; returns a short-lived verificationToken for register. */
  @Post('email-otp/verify')
  @HttpCode(200)
  verifyEmailOtp(@Body() dto: VerifyEmailOtpDto) {
    return this.authService.verifyEmailOtp(dto);
  }

  /** Step 3: create the account (requires the verificationToken from step 2). */
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // REMOVED: `@Post('google')` used to accept { googleId, email } from the request body and issue
  // tokens for it, with no proof that the caller owns that Google account — i.e. anyone could log
  // in as any user by posting their email. Google sign-in now lives in GoogleAuthModule
  // (GET /auth/google, GET /auth/google/callback, POST /auth/google/exchange).

  @Post('refresh')
  refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  // inside AuthController
  /** Changes the password of the signed-in user. The user comes from the validated JWT, never the body. */
  @Patch('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  // @Throttle({ default: { limit: 5, ttl: 60_000 } }) // ADAPT: enable if you use @nestjs/throttler
  changePassword(@Req() req: { user: User }, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto);
  }

  @Post('forgot-password') @HttpCode(200)
  // @Throttle({ default: { limit: 5, ttl: 60_000 } }) // ADAPT: if you use @nestjs/throttler
  forgotPassword(@Body() dto: ForgotPasswordDto) { return this.passwordReset.forgotPassword(dto); }

  @Post('verify-reset-otp') @HttpCode(200)
  verifyResetOtp(@Body() dto: VerifyResetOtpDto) { return this.passwordReset.verifyResetOtp(dto); }

  @Post('reset-password') @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) { return this.passwordReset.resetPassword(dto); }
}