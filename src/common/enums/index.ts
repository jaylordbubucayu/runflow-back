export enum UserRole {
  ADMIN = 'admin',
  ORGANIZER = 'organizer',
  RUNNER = 'runner',
}

export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
}

export enum GenderRestriction {
  ALL = 'all',
  MALE = 'male',
  FEMALE = 'female',
}

export enum OrganizationStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

export enum EventStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  REG_OPEN = 'reg_open',
  REG_CLOSED = 'reg_closed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum CheckpointType {
  START = 'start',
  CHECKPOINT = 'checkpoint',
  WATER = 'water',
  MEDICAL = 'medical',
  FINISH = 'finish',
}

export enum RegistrationStatus {
  PENDING_PAYMENT = 'pending_payment',
  REGISTERED = 'registered',
  CANCELLED = 'cancelled',
  CHECKED_IN = 'checked_in',
  COMPLETED = 'completed',
}

export enum PaymentProvider {
  PAYMONGO = 'paymongo',
}

export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  // Our own payment-link timeout elapsed before the link was paid (PayMongo links never expire
  // by themselves). See PaymentSettlementService.expire().
  EXPIRED = 'expired',
}

/**
 * Why a payment exists. Stored on every payments row and decided by the BACKEND at creation time
 * — webhooks and status lookups always read it from the stored row, never from the request.
 */
export enum PaymentPurpose {
  /** A runner paying the registration fee for an event category. */
  RUNNER_REGISTRATION = 'runner_registration',
  /** An organizer paying the platform's fee to publish an event. Never a runner payment. */
  ORGANIZER_EVENT_CREATION = 'organizer_event_creation',
}

export enum WebhookEventStatus {
  RECEIVED = 'received',
  PROCESSED = 'processed',
  IGNORED = 'ignored',
  FAILED = 'failed',
}

export enum FeeType {
  FIXED = 'fixed',
  PERCENTAGE = 'percentage',
  FIXED_PLUS_PERCENTAGE = 'fixed_plus_percentage',
}

export enum AchievementCriteriaType {
  DISTANCE_TOTAL = 'distance_total',
  EVENT_COUNT = 'event_count',
  PODIUM = 'podium',
  EARLY_RUN = 'early_run',
  FIRST_RUN = 'first_run',
  PB = 'pb',
}

export enum PayoutAccountType {
  BANK = 'bank',
  WALLET = 'wallet',
  CARD = 'card',
}

export enum PayoutAccountStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  FAILED = 'failed',
}

export enum CouponDiscountType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
}