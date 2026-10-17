import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { User } from '../users/entities/user.entity';
import { RunnerProfile } from '../users/entities/runner-profile.entity';
import { EmailVerification } from '../email/entities/email-verification.entity'; // adjust path
import { UserRole } from '../common/enums';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendEmailOtpDto, VerifyEmailOtpDto } from '../email/dto/verify-email.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { EmailService } from '../email/email.service';
import { ChangePasswordDto } from './dto/change-password.dto';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const VERIFICATION_TOKEN_TTL = '30m';
const VERIFICATION_PURPOSE = 'email-verification';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(RunnerProfile)
    private readonly runnerProfilesRepo: Repository<RunnerProfile>,
    @InjectRepository(EmailVerification)
    private readonly verificationsRepo: Repository<EmailVerification>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  /** Public: GoogleAuthService issues the same token pair after a verified Google sign-in. */
  async issueTokens(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRES_IN') ?? '15m',
    });
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN') ?? '7d',
    });
    return { accessToken, refreshToken };
  }

  /**
   * Fire-and-forget: registration must never fail or slow down because of the welcome email.
   * Failures are already recorded in email_logs by EmailService.
   */
  private sendWelcomeEmail(user: User, firstName: string) {
    const appName = this.configService.get<string>('APP_NAME') ?? 'Runflow';
    void this.emailService
      .sendTemplate({
        to: user.email,
        subject: `Welcome to ${appName}!`,
        template: 'welcome',
        context: {
          appName,
          firstName,
          loginUrl: this.configService.get<string>('FRONTEND_URL'),
        },
        metadata: { event: 'welcome', userId: user.id },
      })
      .catch((err: Error) =>
        this.logger.warn(`Welcome email failed for user ${user.id}: ${err.message}`),
      );
  }

  // ---------------------------------------------------------------------------
  // Email OTP (before the account exists)
  // ---------------------------------------------------------------------------

  private hashOtp(email: string, code: string): string {
    return createHmac('sha256', this.configService.getOrThrow<string>('OTP_SECRET'))
      .update(`${email}:${code}`)
      .digest('hex');
  }

  /** Step 1: email a 6-digit code. Also used for "Resend code". */
  async sendEmailOtp(dto: SendEmailOtpDto) {
    const email = this.normalizeEmail(dto.email);
    const result = { message: 'Verification code sent.' };

    const existing = await this.usersRepo.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    // Cooldown: the earlier code is still valid, so just don't send another yet.
    const latest = await this.verificationsRepo.findOne({
      where: { email },
      order: { createdAt: 'DESC' },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      return result;
    }

    // Invalidate older unused codes for this address.
    await this.verificationsRepo.update(
      { email, consumedAt: IsNull() },
      { consumedAt: new Date() },
    );

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const row = await this.verificationsRepo.save(
      this.verificationsRepo.create({
        email,
        codeHash: this.hashOtp(email, code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        createdAt: new Date(),
      }),
    );

    const appName = this.configService.get<string>('APP_NAME') ?? 'Runflow';
    try {
      // Awaited on purpose: the user is waiting on this email, so a failure must be visible.
      await this.emailService.sendTemplate({
        to: email,
        subject: `${code} is your ${appName} verification code`,
        template: 'verify-email',
        context: { appName, firstName: '', code, expiresInMinutes: OTP_TTL_MS / 60000 },
        metadata: { event: 'verify-email' },
      });
    } catch (err) {
      this.logger.warn(`OTP email failed: ${(err as Error).message}`);
      await this.verificationsRepo.delete(row.id); // don't leave a cooldown behind a code that never arrived
      throw new ServiceUnavailableException('We could not send the code. Please try again.');
    }

    return result;
  }

  /** Step 2: check the code and hand back a short-lived token that register requires. */
  async verifyEmailOtp(dto: VerifyEmailOtpDto) {
    const invalid = () => new BadRequestException('Invalid or expired code');
    const email = this.normalizeEmail(dto.email);

    const otp = await this.verificationsRepo.findOne({
      where: { email, consumedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    if (!otp || otp.expiresAt < new Date() || otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw invalid();
    }

    await this.verificationsRepo.increment({ id: otp.id }, 'attempts', 1);

    const given = Buffer.from(this.hashOtp(email, dto.code));
    const expected = Buffer.from(otp.codeHash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw invalid();
    }

    // Atomic single-use: only one request can flip consumedAt from NULL.
    const res = await this.verificationsRepo.update(
      { id: otp.id, consumedAt: IsNull() },
      { consumedAt: new Date() },
    );
    if (!res.affected) throw invalid();

    const verificationToken = this.jwtService.sign(
      { email, purpose: VERIFICATION_PURPOSE },
      {
        secret: this.configService.getOrThrow<string>('OTP_SECRET'),
        expiresIn: VERIFICATION_TOKEN_TTL,
      },
    );
    return { verificationToken };
  }

  private assertVerificationToken(email: string, token: string) {
    const fail = () =>
      new BadRequestException('Email verification expired. Please verify your email again.');
    try {
      const payload = this.jwtService.verify<{ email: string; purpose: string }>(token, {
        secret: this.configService.getOrThrow<string>('OTP_SECRET'),
      });
      if (payload.purpose !== VERIFICATION_PURPOSE || payload.email !== email) throw fail();
    } catch {
      throw fail();
    }
  }

  // ---------------------------------------------------------------------------
  // Register / login / Google / refresh
  // ---------------------------------------------------------------------------

  async register(dto: RegisterDto) {
    const email = this.normalizeEmail(dto.email);

    // Proves this address was confirmed with a code moments ago.
    this.assertVerificationToken(email, dto.verificationToken);

    const existing = await this.usersRepo.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.usersRepo.create({
      email,
      passwordHash,
      role: dto.role ?? UserRole.RUNNER,
    });
    const savedUser = await this.usersRepo.save(user);

    const profile = this.runnerProfilesRepo.create({
      userId: savedUser.id,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
    await this.runnerProfilesRepo.save(profile);

    this.sendWelcomeEmail(savedUser, dto.firstName);

    return this.issueTokens(savedUser);
  }

  async login(dto: LoginDto) {
    const user = await this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('LOWER(user.email) = :email', { email: this.normalizeEmail(dto.email) })
      .getOne();

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account suspended');

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
      });
      const user = await this.usersRepo.findOne({
        where: { id: payload.sub },
      });
      if (!user) throw new UnauthorizedException();
      return this.issueTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async validateUser(payload: JwtPayload) {
    const user = await this.usersRepo.findOne({ where: { id: payload.sub } });
    if (!user || !user.isActive) return null;
    return user;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    // passwordHash is select:false, so add it explicitly (same pattern as login).
    const user = await this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: userId })
      .getOne();

    if (!user || !user.isActive) throw new UnauthorizedException();
    if (!user.passwordHash) {
      // Google-only account: there is no password to change.
      throw new ForbiddenException('This account signs in with Google and has no password.');
    }

    const matches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!matches) throw new UnauthorizedException('Current password is incorrect');

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('New password must be different from the current password');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10); // same cost as register
    await this.usersRepo.update({ id: user.id }, { passwordHash });

    return { message: 'Your password has been updated successfully.' };
  }
}