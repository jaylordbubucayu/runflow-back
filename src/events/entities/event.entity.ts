import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { EventStatus } from '../../common/enums';
import { Organization } from '../../organizations/entities/organization.entity';
import { EventCategory } from './event-category.entity';
import { EventPrize } from './event-prize.entity';
import { EventFreebie } from './event-freebie.entity';
import { EventCheckpoint } from './event-checkpoint.entity';
import { EventCoupon } from './event-coupon.entity';

@Entity('events')
export class Event {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', name: 'banner_url', nullable: true })
  bannerUrl: string;

  // Up to 3 uploaded images (see UploadsController). bannerUrl above is kept in sync as
  // bannerUrls[0] by EventsService so existing single-image display code needs no changes.
  @Column({ type: 'json', name: 'banner_urls', nullable: true })
  bannerUrls: string[] | null;

  @Column({ type: 'date', name: 'event_date' })
  eventDate: string;

  @Column({ type: 'datetime', name: 'registration_start' })
  registrationStart: Date;

  @Column({ type: 'datetime', name: 'registration_end' })
  registrationEnd: Date;

  @Column({ type: 'varchar' })
  venue: string;

  @Column({ type: 'varchar' })
  location: string;

  @Column({ type: 'time', name: 'assembly_time', nullable: true })
  assemblyTime: string;

  @Column({ type: 'time', name: 'starting_time', nullable: true })
  startingTime: string;

  @Column({ type: 'varchar', name: 'contact_email', nullable: true })
  contactEmail: string;

  @Column({ type: 'varchar', name: 'contact_number', nullable: true })
  contactNumber: string;

  @Column({ type: 'enum', enum: EventStatus, default: EventStatus.DRAFT })
  status: EventStatus;

  @Column({ type: 'varchar', name: 'route_image_url', nullable: true })
  routeImageUrl: string;

  // Road-snapped path as [lng, lat] pairs (GeoJSON order). Nullable: an event
  // may instead (or additionally) use routeImageUrl.
  @Column({ type: 'json', name: 'route_coordinates', nullable: true })
  routeCoordinates: number[][] | null;

  @Column({ type: 'text', name: 'route_description', nullable: true })
  routeDescription: string;

  @Column({
    type: 'decimal',
    name: 'route_distance_km',
    precision: 6,
    scale: 2,
    nullable: true,
  })
  routeDistanceKm: string;

  @Column({ type: 'int', name: 'route_elevation_m', nullable: true })
  routeElevationM: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Organization, (org) => org.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @OneToMany(() => EventCategory, (category) => category.event)
  categories: EventCategory[];

  @OneToMany(() => EventPrize, (prize) => prize.event)
  prizes: EventPrize[];

  @OneToMany(() => EventFreebie, (freebie) => freebie.event)
  freebies: EventFreebie[];

  @OneToMany(() => EventCheckpoint, (checkpoint) => checkpoint.event)
  checkpoints: EventCheckpoint[];

  @OneToMany(() => EventCoupon, (coupon) => coupon.event)
  coupons: EventCoupon[];
}