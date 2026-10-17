import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { Certificate } from './entities/certificate.entity';

@Injectable()
export class CertificatesService {
  constructor(
    @InjectRepository(Certificate)
    private readonly certificatesRepo: Repository<Certificate>,
    @InjectQueue('certificates') private readonly certificatesQueue: Queue,
  ) {}

  @OnEvent('result.published')
  async onResultPublished(payload: { registrationId: string }) {
    await this.certificatesQueue.add('generate', {
      registrationId: payload.registrationId,
    });
  }

  // Executed by the BullMQ worker/processor (see certificates.processor.ts).
  async generate(registrationId: string) {
    // TODO: render the actual PDF (e.g. via a headless renderer) and upload
    // to S3-compatible storage; storing a placeholder URL here.
    const certificateUrl = `https://cdn.runflow.app/certificates/${registrationId}.pdf`;

    let certificate = await this.certificatesRepo.findOne({
      where: { registrationId },
    });
    certificate = this.certificatesRepo.create({
      ...certificate,
      registrationId,
      certificateUrl,
      generatedAt: new Date(),
    });
    return this.certificatesRepo.save(certificate);
  }

  async getForRegistration(registrationId: string) {
    const certificate = await this.certificatesRepo.findOne({
      where: { registrationId },
    });
    if (!certificate) throw new NotFoundException('Certificate not ready yet');
    return certificate;
  }
}
