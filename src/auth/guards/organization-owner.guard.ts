import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../common/enums';
import { Organization } from '../../organizations/entities/organization.entity';
import { Event } from '../../events/entities/event.entity';

/**
 * Ensures an organizer can only act on events/resources belonging to
 * their own Organization. Admins bypass this check.
 * Expects an `:id` (event id) or `:eventId` route param.
 */
@Injectable()
export class OrganizationOwnerGuard implements CanActivate {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationsRepo: Repository<Organization>,
    @InjectRepository(Event)
    private readonly eventsRepo: Repository<Event>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return false;
    if (user.role === UserRole.ADMIN) return true;
    if (user.role !== UserRole.ORGANIZER) return false;

    const eventId = request.params.eventId ?? request.params.id;
    if (!eventId) return false;

    const org = await this.organizationsRepo.findOne({
      where: { ownerUserId: user.id },
    });
    if (!org) throw new ForbiddenException('No organization found for user');

    const event = await this.eventsRepo.findOne({ where: { id: eventId } });
    if (!event) return false;

    if (event.organizationId !== org.id) {
      throw new ForbiddenException('You do not own this event');
    }
    return true;
  }
}
