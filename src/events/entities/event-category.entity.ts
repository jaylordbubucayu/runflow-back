import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { GenderRestriction } from '../../common/enums';
import { Event } from './event.entity';
import { EventPrize } from './event-prize.entity';
import { Registration } from '../../registrations/entities/registration.entity';

@Entity('event_categories')
export class EventCategory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'decimal', name: 'distance_km', precision: 6, scale: 2 })
  distanceKm: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: string;

  @Column({ type: 'int', name: 'slots_total' })
  slotsTotal: number;

  @Column({ type: 'int', name: 'slots_remaining' })
  slotsRemaining: number;

  @Column({ type: 'int', name: 'min_age', nullable: true })
  minAge: number;

  @Column({ type: 'int', name: 'max_age', nullable: true })
  maxAge: number;

  @Column({
    type: 'enum',
    enum: GenderRestriction,
    name: 'gender_restriction',
    default: GenderRestriction.ALL,
  })
  genderRestriction: GenderRestriction;

  // Each category has its own full route now (map, distance, elevation, description) — there is
  // no single event-level route anymore. distanceKm above is the category's official race
  // distance (e.g. "10K"); routeDistanceKm here is the actual measured route length, which may
  // differ slightly (auto-computed from routeCoordinates when the organizer draws a route
  // without typing a distance — see EventsService.setCategoryRoute).
  @Column({ type: 'varchar', name: 'route_image_url', nullable: true })
  routeImageUrl: string;

  // Road-snapped path as [lng, lat] pairs (GeoJSON order). Nullable: a category may instead
  // (or additionally) use routeImageUrl.
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

  @ManyToOne(() => Event, (event) => event.categories, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @OneToMany(() => EventPrize, (prize) => prize.category)
  prizes: EventPrize[];

  @OneToMany(() => Registration, (registration) => registration.category)
  registrations: Registration[];
}