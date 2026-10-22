import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Gender, RegistrationStatus } from '../../common/enums';
import { Event } from '../../events/entities/event.entity';
import { EventCategory } from '../../events/entities/event-category.entity';
import { User } from '../../users/entities/user.entity';
import { Payment } from '../../payments/entities/payment.entity';
import { CheckIn } from '../../checkin/entities/check-in.entity';
import { Result } from '../../results/entities/result.entity';
import { Certificate } from '../../certificates/entities/certificate.entity';

@Entity('registrations')
@Index('uq_registrations_event_bib', ['eventId', 'bibNumber'], { unique: true })
export class Registration {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', name: 'registration_code', unique: true })
  registrationCode: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId: string;

  @Column({ type: 'bigint', name: 'category_id' })
  categoryId: string;

  @Column({ type: 'bigint', name: 'runner_user_id' })
  runnerUserId: string;

  @Column({ type: 'varchar', name: 'first_name' })
  firstName: string;

  @Column({ type: 'varchar', name: 'last_name' })
  lastName: string;

  @Column({ type: 'date' })
  birthday: string;

  @Column({ type: 'enum', enum: Gender })
  gender: Gender;

  @Column({ type: 'varchar', name: 'mobile_number' })
  mobileNumber: string;

  @Column({ type: 'varchar' })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  address: string;

  @Column({ type: 'varchar', name: 'emergency_contact_name' })
  emergencyContactName: string;

  @Column({ type: 'varchar', name: 'emergency_contact_number' })
  emergencyContactNumber: string;

  @Column({ type: 'varchar', name: 'shirt_size', nullable: true })
  shirtSize: string;

  @Column({ type: 'varchar', name: 'bib_number', nullable: true })
  bibNumber: string;

  @Column({ type: 'varchar', name: 'qr_token', unique: true, nullable: true })
  qrToken: string;

  @Column({
    type: 'enum',
    enum: RegistrationStatus,
    default: RegistrationStatus.PENDING_PAYMENT,
  })
  status: RegistrationStatus;

  @Column({ type: 'datetime', name: 'registered_at', nullable: true })
  registeredAt: Date;

  // Multi-participant guest registration: several registrations created together share one
  // group_id, then share one payment_id once checkout succeeds (see
  // RegistrationsService.createGuestBatch and PaymentsService.createGroupCheckout). Both are
  // null for an ordinary single registration, which keeps using `payments.registration_id`
  // (below) exactly as before.
  @Column({ type: 'varchar', name: 'group_id', nullable: true })
  groupId: string | null;

  @Column({ type: 'bigint', name: 'payment_id', nullable: true })
  paymentId: string | null;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => EventCategory, (category) => category.registrations, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'category_id' })
  category: EventCategory;

  @ManyToOne(() => User, (user) => user.registrations, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'runner_user_id' })
  runner: User;

  @OneToMany(() => Payment, (payment) => payment.registration)
  payments: Payment[];

  // The ONE payment that covers this registration via the group-checkout mechanism (see
  // paymentId above). Distinct from `payments` above, which is the single-registration flow's
  // history of payment attempts keyed the other direction (payments.registration_id).
  @ManyToOne(() => Payment, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'payment_id' })
  payment: Payment | null;

  @OneToOne(() => CheckIn, (checkIn) => checkIn.registration)
  checkIn: CheckIn;

  @OneToOne(() => Result, (result) => result.registration)
  result: Result;

  @OneToOne(() => Certificate, (certificate) => certificate.registration)
  certificate: Certificate;

    // Locked in at creation time (see RegistrationsService.startRegistration / createGuestBatch),
  // not recomputed later — so a coupon that changes or expires after someone registers doesn't
  // retroactively change what they already agreed to pay. couponId is nullable with ON DELETE
  // SET NULL so deleting a coupon doesn't delete registration history; couponCode is kept
  // separately so the record of "what code did they use" survives even if the coupon itself is
  // later deleted.
  @Column({ type: 'bigint', name: 'coupon_id', nullable: true })
  couponId: string | null;

  @Column({ type: 'varchar', name: 'coupon_code', length: 32, nullable: true })
  couponCode: string | null;

  @Column({ type: 'decimal', name: 'discount_amount', precision: 10, scale: 2, nullable: true })
  discountAmount: string | null;
}