import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity'; // ADAPT paths
import { EmailService } from '../email/email.service';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { ForgotPasswordDto, ResetPasswordDto, VerifyResetOtpDto } from './dto/password-reset.dto';

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 5;

const GENERIC_RESPONSE = {
  message: 'If an account exists for that email, a verification code will be sent.',
};

/**
 * Forgot-password flow shared by runners and organizers: both are rows in `users`
 * (role column), so one challenge table keyed by userId covers both.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(PasswordResetChallenge)
    private readonly resetsRepo: Repository<PasswordResetChallenge>,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  /** Domain-separated HMAC so an OTP hash can never be confused with a token hash. */
  private hmac(scope: 'reset-otp' | 'reset-token', value: string): string {
    return createHmac('sha256', this.configService.getOrThrow<string>('OTP_SECRET'))
      .update(`${scope}:${value}`)
      .digest('hex');
  }

  private findUserByEmail(email: string) {
    return this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email })
      .getOne();
  }

  /** Step 1. Always answers the same way, whether or not the account exists. */
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.findUserByEmail(this.normalizeEmail(dto.email));
    if (!user || !user.isActive) return GENERIC_RESPONSE;

    // Resend cooldown + hourly cap per account (silent, to avoid revealing anything).
    const latest = await this.resetsRepo.findOne({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return GENERIC_RESPONSE;
    }
    const recent = await this.resetsRepo.count({
      where: { userId: user.id, createdAt: MoreThan(new Date(Date.now() - 60 * 60 * 1000)) },
    });
    if (recent >= MAX_REQUESTS_PER_HOUR) return GENERIC_RESPONSE;

    // A new code supersedes every outstanding one for this account.
    await this.resetsRepo.update({ userId: user.id, consumedAt: IsNull() }, { consumedAt: new Date() });

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const row = await this.resetsRepo.save(
      this.resetsRepo.create({
        userId: user.id,
        otpHash: this.hmac('reset-otp', `${user.id}:${code}`),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        createdAt: new Date(),
      }),
    );

    // Fire-and-forget: awaiting would make the response time/failure reveal whether the
    // account exists. If delivery fails, drop the row so it can't block a retry via cooldown.
    const appName = this.configService.get<string>('APP_NAME') ?? 'Runflow';
    void this.emailService
      .sendTemplate({
        to: user.email,
        subject: `Your ${appName} Password Reset Code`,
        template: 'reset-password',
        context: { appName, code, expiresInMinutes: OTP_TTL_MS / 60000 },
        metadata: { event: 'password-reset', userId: user.id },
      })
      .catch(async (err: Error) => {
        this.logger.warn(`Password reset email failed for user ${user.id}: ${err.message}`);
        await this.resetsRepo.delete(row.id).catch(() => undefined);
      });

    return GENERIC_RESPONSE;
  }

  /** Step 2. Checks the OTP and, only if correct, issues a one-time opaque reset token. */
  async verifyResetOtp(dto: VerifyResetOtpDto) {
    const invalid = () => new BadRequestException('Invalid or expired code');

    const user = await this.findUserByEmail(this.normalizeEmail(dto.email));
    if (!user || !user.isActive) throw invalid();

    const challenge = await this.resetsRepo.findOne({
      where: { userId: user.id, consumedAt: IsNull(), verifiedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    if (!challenge || challenge.expiresAt < new Date()) throw invalid();

    // Atomic attempt counter: concurrent guesses can't slip past the limit.
    const counted = await this.resetsRepo
      .createQueryBuilder()
      .update(PasswordResetChallenge)
      .set({ attempts: () => 'attempts + 1' })
      .where('id = :id AND attempts < :max', { id: challenge.id, max: MAX_OTP_ATTEMPTS })
      .execute();
    if (!counted.affected) throw invalid();

    const given = Buffer.from(this.hmac('reset-otp', `${user.id}:${dto.otp}`));
    const expected = Buffer.from(challenge.otpHash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();

    // The reset token is random (not a JWT), so it can never be used as an access token.
    const resetToken = randomBytes(32).toString('base64url');
    const verified = await this.resetsRepo.update(
      { id: challenge.id, verifiedAt: IsNull(), consumedAt: IsNull() },
      {
        verifiedAt: new Date(),
        resetTokenHash: this.hmac('reset-token', resetToken),
        resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    );
    if (!verified.affected) throw invalid(); // lost a race: the OTP is single-use

    return { resetToken, expiresInSeconds: RESET_TOKEN_TTL_MS / 1000 };
  }

  /** Step 3. Needs the reset token (not just email + OTP). */
  async resetPassword(dto: ResetPasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }
    const expired = () =>
      new BadRequestException('Your reset session has expired. Please start again.');

    const challenge = await this.resetsRepo.findOne({
      where: { resetTokenHash: this.hmac('reset-token', dto.resetToken), consumedAt: IsNull() },
    });
    if (!challenge || !challenge.resetTokenExpiresAt || challenge.resetTokenExpiresAt < new Date()) {
      throw expired();
    }

    // The account comes from the server-side challenge, never from the request.
    const user = await this.usersRepo.findOne({ where: { id: challenge.userId } });
    if (!user || !user.isActive) throw expired();

    const passwordHash = await bcrypt.hash(dto.newPassword, 10); // same cost as register

    await this.usersRepo.manager.transaction(async (m) => {
      // Single-use: only one request can flip consumedAt from NULL.
      const used = await m.update(
        PasswordResetChallenge,
        { id: challenge.id, consumedAt: IsNull() },
        { consumedAt: new Date() },
      );
      if (!used.affected) throw expired();

      await m.update(User, { id: user.id }, { passwordHash });

      // Kill any other outstanding challenges for this account.
      await m.update(
        PasswordResetChallenge,
        { userId: user.id, consumedAt: IsNull() },
        { consumedAt: new Date() },
      );
    });

    return { message: 'Your password has been reset successfully.' };
  }

  /** Housekeeping. ADAPT: call from a @Cron job if you use @nestjs/schedule. */
  // @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpired() {
    await this.resetsRepo.delete({ expiresAt: LessThan(new Date(Date.now() - 24 * 60 * 60 * 1000)) });
  }
}
