import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Registration } from '../../registrations/entities/registration.entity';

@Entity('certificates')
export class Certificate {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'registration_id', unique: true })
  registrationId: string;

  @Column({ type: 'varchar', name: 'certificate_url' })
  certificateUrl: string;

  @Column({ type: 'datetime', name: 'generated_at' })
  generatedAt: Date;

  @OneToOne(() => Registration, (registration) => registration.certificate, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'registration_id' })
  registration: Registration;
}
