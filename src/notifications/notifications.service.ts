import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Notification } from './entities/notification.entity';
import { Registration } from '../registrations/entities/registration.entity';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    @InjectRepository(Registration)
    private readonly registrationsRepo: Repository<Registration>,
  ) {}

  private async create(userId: string, type: string, title: string, body: string) {
    const notification = this.notificationsRepo.create({
      userId,
      type,
      title,
      body,
    });
    return this.notificationsRepo.save(notification);
  }

  @OnEvent('payment.succeeded')
  async onPaymentSucceeded(payload: { registrationId: string }) {
    const registration = await this.registrationsRepo.findOne({
      where: { id: payload.registrationId },
    });
    if (!registration) return;
    await this.create(
      registration.runnerUserId,
      'payment_succeeded',
      'Payment confirmed',
      `Your registration ${registration.registrationCode} is confirmed. Bib #${registration.bibNumber}.`,
    );
  }

  @OnEvent('registration.checked_in')
  async onCheckedIn(payload: { registrationId: string; userId: string }) {
    await this.create(
      payload.userId,
      'checked_in',
      "You're checked in!",
      'Good luck out there — have a great race.',
    );
  }

  @OnEvent('result.published')
  async onResultPublished(payload: { userId: string }) {
    await this.create(
      payload.userId,
      'result_published',
      'Your result is in',
      'Your race result has been published — check your stats.',
    );
  }

  @OnEvent('achievement.earned')
  async onAchievementEarned(payload: { userId: string; achievementId: string }) {
    await this.create(
      payload.userId,
      'achievement_earned',
      'Achievement unlocked!',
      "You've earned a new achievement.",
    );
  }

  async getForUser(userId: string) {
    return this.notificationsRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async markRead(notificationId: string) {
    await this.notificationsRepo.update(notificationId, { isRead: true });
    return this.notificationsRepo.findOne({ where: { id: notificationId } });
  }
}
