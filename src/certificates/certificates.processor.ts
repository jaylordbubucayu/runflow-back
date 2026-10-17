import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { CertificatesService } from './certificates.service';

@Processor('certificates')
export class CertificatesProcessor extends WorkerHost {
  constructor(private readonly certificatesService: CertificatesService) {
    super();
  }

  async process(job: Job<{ registrationId: string }>) {
    if (job.name === 'generate') {
      return this.certificatesService.generate(job.data.registrationId);
    }
  }
}
