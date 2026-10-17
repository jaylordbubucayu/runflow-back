import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Event } from './event.entity';
import { CouponDiscountType } from '../../common/enums';

/**
 * A discount code scoped to ONE event. Applies to every category in that event (no
 * per-category restriction in this version). Redemption is atomic (conditional UPDATE on
 * uses_count, see EventsService.redeemCoupon) so concurrent registrations can't both claim the
 * last use of a capped coupon.
 */
@Entity('event_coupons')
export class EventCoupon {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId: string;

  @Column({ type: 'varchar', length: 32 })
  code: string;

  @Column({ type: 'enum', enum: CouponDiscountType, name: 'discount_type' })
  discountType: CouponDiscountType;

  // For 'percentage': 0-100. For 'fixed': a peso amount. Validated in the DTO, not here.
  @Column({ type: 'decimal', name: 'discount_value', precision: 10, scale: 2 })
  discountValue: string;

  // null = unlimited.
  @Column({ type: 'int', name: 'max_uses', nullable: true })
  maxUses: number | null;

  @Column({ type: 'int', name: 'uses_count', default: 0 })
  usesCount: number;

  // How many times the SAME participant email can use this one coupon. Default 1 — the common
  // case ("one discount per person"), not a global cap (that's max_uses above).
  @Column({ type: 'int', name: 'max_uses_per_user', default: 1 })
  maxUsesPerUser: number;

  @Column({ type: 'datetime', name: 'valid_from', nullable: true })
  validFrom: Date | null;

  @Column({ type: 'datetime', name: 'valid_until', nullable: true })
  validUntil: Date | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;
}