import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuestRegistrationSupport1790000000000
  implements MigrationInterface
{
  name = 'AddGuestRegistrationSupport1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guest checkout auto-creates a real `users` row (unusable password) so every existing
    // query that joins on runner_user_id keeps working untouched. `is_guest` distinguishes that
    // from a real account, which matters for one thing: if a later guest checkout reuses an
    // email that already belongs to a REAL (non-guest) account, we refuse rather than silently
    // attaching someone else's registration to a stranger's account.
    await queryRunner.query(
      'ALTER TABLE `users` ADD `is_guest` tinyint NOT NULL DEFAULT 0',
    );

    // Multi-participant guest registration: several `registrations` rows share one `group_id`
    // (set at creation) and, once checkout succeeds, one `payment_id` (set by
    // PaymentsService.createGroupCheckout). This is a SEPARATE mechanism from the existing
    // single-registration flow, which still uses `payments.registration_id` exactly as before —
    // a group payment just leaves that column NULL instead.
    await queryRunner.query(
      'ALTER TABLE `registrations` ' +
        'ADD `group_id` varchar(36) NULL, ' +
        'ADD `payment_id` bigint NULL, ' +
        'ADD INDEX `IDX_registrations_group_id` (`group_id`), ' +
        'ADD CONSTRAINT `FK_registrations_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE SET NULL',
    );

    // A group payment covers many registrations at once, so it can no longer always point at
    // exactly one. The existing single-registration flow is unaffected — it still always sets
    // this column; only group payments leave it NULL.
    await queryRunner.query(
      'ALTER TABLE `payments` MODIFY `registration_id` bigint NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `payments` MODIFY `registration_id` bigint NOT NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `registrations` ' +
        'DROP FOREIGN KEY `FK_registrations_payment`, ' +
        'DROP INDEX `IDX_registrations_group_id`, ' +
        'DROP COLUMN `payment_id`, ' +
        'DROP COLUMN `group_id`',
    );
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `is_guest`');
  }
}
