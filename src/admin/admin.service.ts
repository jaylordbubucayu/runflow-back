import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Organization } from '../organizations/entities/organization.entity';
import { Event } from '../events/entities/event.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { OrganizationStatus } from '../common/enums';
import { PaymentsService } from '../payments/payments.service';
import { UsersService } from '../users/users.service';
import { SetFeeConfigDto } from '../payments/dto/set-fee-config.dto';
import { OrganizerFeeService } from '../organizer-fee/organizer-fee.service';
import { SetOrganizerFeeDto } from '../organizer-fee/dto/set-organizer-fee.dto';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(Organization)
    private readonly orgsRepo: Repository<Organization>,
    private readonly paymentsService: PaymentsService,
    private readonly organizerFees: OrganizerFeeService,
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
  ) {}

  async getDashboardSummary() {
    const totalOrgs = await this.orgsRepo.count();
    const runners = await this.usersService.listForAdmin({ role: 'runner' });
    const totalRunners = runners.length;

    const raw = await this.dataSource
      .createQueryBuilder()
      .select('COUNT(DISTINCT e.id)', 'totalEvents')
      .addSelect('COUNT(DISTINCT p.id)', 'totalTransactions')
      .addSelect('COALESCE(SUM(p.total_amount), 0)', 'grossValue')
      .addSelect('COALESCE(SUM(p.platform_fee), 0)', 'platformRevenue')
      .from('events', 'e')
      .leftJoin('registrations', 'r', 'r.event_id = e.id')
      .leftJoin('payments', 'p', 'p.registration_id = r.id AND p.status = :paid', {
        paid: 'paid',
      })
      .getRawOne();

    return {
      totalOrganizations: totalOrgs,
      totalRunners,
      ...raw,
    };
  }

  async getRevenueAnalytics(range: string, groupBy: 'event' | 'organizer' | 'time') {
    const qb = this.dataSource
      .createQueryBuilder()
      .select('COALESCE(SUM(p.total_amount), 0)', 'grossValue')
      .addSelect('COALESCE(SUM(p.platform_fee), 0)', 'platformRevenue')
      .from('payments', 'p')
      .where("p.status = 'paid'")
      // Runner revenue only; organizer platform fees are reported separately and must not be
      // mixed into runner gross/platform figures.
      .andWhere("p.purpose = 'runner_registration'");

    if (groupBy === 'event') {
      qb.leftJoin('registrations', 'r', 'r.id = p.registration_id')
        .addSelect('r.event_id', 'eventId')
        .groupBy('r.event_id');
    } else if (groupBy === 'organizer') {
      qb.leftJoin('registrations', 'r', 'r.id = p.registration_id')
        .leftJoin('events', 'e', 'e.id = r.event_id')
        .addSelect('e.organization_id', 'organizationId')
        .groupBy('e.organization_id');
    } else {
      qb.addSelect('DATE(p.paid_at)', 'day').groupBy('DATE(p.paid_at)');
    }

    return qb.getRawMany();
  }

  async setFeeConfig(dto: SetFeeConfigDto) {
    return this.paymentsService.setFeeConfig(dto);
  }

  async getFeeConfig(organizationId?: string) {
    return this.paymentsService.getFeeConfig(organizationId);
  }

  async listOrganizations(filters: { status?: OrganizationStatus }) {
    const qb = this.orgsRepo.createQueryBuilder('org');
    if (filters.status) {
      qb.andWhere('org.status = :status', { status: filters.status });
    }
    return qb.getMany();
  }

  async setOrganizationStatus(id: string, status: OrganizationStatus) {
    const org = await this.orgsRepo.findOne({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found');
    await this.orgsRepo.update(id, { status });
    return this.orgsRepo.findOne({ where: { id } });
  }

  // Read-only platform-wide lists for the admin console. Capped so an
  // unbounded table can't be pulled in one request.
  async listEvents() {
    return this.dataSource.getRepository(Event).find({
      relations: ['organization'],
      order: { createdAt: 'DESC' },
      take: 500,
    });
  }

  async listRegistrations() {
    const rows = await this.dataSource.getRepository(Registration).find({
      relations: ['event', 'category'],
      order: { id: 'DESC' },
      take: 500,
    });
    // qrToken is a bearer credential for check-in; the console doesn't need it.
    return rows.map(({ qrToken: _qrToken, ...r }) => r);
  }

  async listUsers(filters: { role?: string; isActive?: boolean }) {
    return this.usersService.listForAdmin(filters);
  }

  async suspendUser(userId: string) {
    return this.usersService.suspend(userId, false);
  }

  async getOrganizerEventFee() {
    return this.organizerFees.getActiveFee();
  }

  async setOrganizerEventFee(dto: SetOrganizerFeeDto, adminUserId: string) {
    return this.organizerFees.setFee(dto, adminUserId);
  }

  async getReconciliationQueue() {
    return this.paymentsService.getReconciliationQueue();
  }

  async getTransactions(filters: any) {
    return this.paymentsService.getTransactionsForAdmin(filters);
  }
}