import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { CheckpointType } from '../../common/enums';
import { Event } from './event.entity';

@Entity('event_checkpoints')
export class EventCheckpoint {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId: string;

  @Column({ type: 'enum', enum: CheckpointType })
  type: CheckpointType;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'int', name: 'sequence_order' })
  sequenceOrder: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  lat: string;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  lng: string;

  @ManyToOne(() => Event, (event) => event.checkpoints, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;
}
