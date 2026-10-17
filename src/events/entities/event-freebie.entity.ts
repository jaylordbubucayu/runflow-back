import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Event } from './event.entity';

@Entity('event_freebies')
export class EventFreebie {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'boolean', name: 'is_custom', default: false })
  isCustom: boolean;

  @ManyToOne(() => Event, (event) => event.freebies, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;
}
