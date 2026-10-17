import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Event } from './event.entity';
import { EventCategory } from './event-category.entity';

@Entity('event_prizes')
export class EventPrize {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId: string;

  @Column({ type: 'bigint', name: 'category_id', nullable: true })
  categoryId: string;

  @Column({ type: 'varchar' })
  position: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  amount: string;

  @Column({ type: 'varchar', nullable: true })
  description: string;

  @ManyToOne(() => Event, (event) => event.prizes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => EventCategory, (category) => category.prizes, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'category_id' })
  category: EventCategory;
}
