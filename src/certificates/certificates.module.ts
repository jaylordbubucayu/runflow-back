import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Certificate } from './entities/certificate.entity';
import { CertificatesService } from './certificates.service';
import { CertificatesController } from './certificates.controller';
import { CertificatesProcessor } from './certificates.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Certificate]),
    BullModule.registerQueue({ name: 'certificates' }),
  ],
  controllers: [CertificatesController],
  providers: [CertificatesService, CertificatesProcessor],
  exports: [CertificatesService],
})
export class CertificatesModule {}
