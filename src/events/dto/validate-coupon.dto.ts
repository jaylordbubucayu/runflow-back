import { IsEmail, IsString } from 'class-validator';

// Preview-only: checked against a specific category + participant email, but does NOT consume a
// use. Lets the frontend show "10% off — ₱450.00" before the runner finishes the registration
// form. The real redemption (which DOES consume a use) happens inside
// RegistrationsService.startRegistration / createGuestBatch via EventsService.redeemCoupon.
export class ValidateCouponDto {
  @IsString()
  code: string;

  @IsString()
  categoryId: string;

  // Needed because max_uses_per_user is checked per participant email, not per logged-in user
  // (guests have no account to check against).
  @IsEmail()
  email: string;
}
