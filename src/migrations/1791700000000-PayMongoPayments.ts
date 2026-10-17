import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PayMongo integration for both payment purposes.
 *
 *  - payments: gains `purpose`, owner/event/organization links, PayMongo link details, centavo
 *    amount, currency, expiry and reconciliation flags. Existing rows become
 *    purpose='runner_registration' and are backfilled (event_id, amount_centavos).
 *  - a UNIQUE `paid_guard_key` makes a second PAID row for the same registration or the same
 *    organizer event fee impossible (MySQL has no partial unique indexes).
 *  - new tables: payment_webhook_events (idempotency), payment_status_logs (audit),
 *    organizer_fee_configs (the organizer's event fee, admin-managed).
 *
 * Additive only: nothing is dropped and no existing data is overwritten.
 */
export class PayMongoPayments1791700000000 implements MigrationInterface {
  name = 'PayMongoPayments1791700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE \`payments\`
        MODIFY \`status\` enum('pending','paid','failed','cancelled','refunded','expired') NOT NULL DEFAULT 'pending',
        ADD \`purpose\` enum('runner_registration','organizer_event_creation') NOT NULL DEFAULT 'runner_registration',
        ADD \`event_id\` bigint NULL,
        ADD \`organization_id\` bigint NULL,
        ADD \`owner_user_id\` bigint NULL,
        ADD \`provider_reference_number\` varchar(255) NULL,
        ADD \`checkout_url\` varchar(512) NULL,
        ADD \`amount_centavos\` bigint NULL,
        ADD \`currency\` varchar(3) NOT NULL DEFAULT 'PHP',
        ADD \`payment_method\` varchar(64) NULL,
        ADD \`expires_at\` datetime NULL,
        ADD \`needs_reconciliation\` tinyint NOT NULL DEFAULT 0,
        ADD \`reconciliation_note\` varchar(255) NULL,
        ADD \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
    `);

    // Backfill existing (runner) payments: event via the registration (single) or via
    // registrations.payment_id (group); amount in centavos from the stored decimal total.
    await q.query(`
      UPDATE \`payments\` p
        JOIN \`registrations\` r ON r.id = p.registration_id
         SET p.event_id = r.event_id
       WHERE p.event_id IS NULL
    `);
    await q.query(`
      UPDATE \`payments\` p
        JOIN (SELECT payment_id, MIN(event_id) AS event_id FROM \`registrations\`
               WHERE payment_id IS NOT NULL GROUP BY payment_id) g ON g.payment_id = p.id
         SET p.event_id = g.event_id
       WHERE p.event_id IS NULL
    `);
    await q.query(`UPDATE \`payments\` SET amount_centavos = ROUND(total_amount * 100) WHERE amount_centavos IS NULL`);

    await q.query(`CREATE INDEX \`IDX_payments_purpose_status\` ON \`payments\` (\`purpose\`, \`status\`)`);
    await q.query(`CREATE INDEX \`IDX_payments_event\` ON \`payments\` (\`event_id\`)`);
    await q.query(`CREATE INDEX \`IDX_payments_owner\` ON \`payments\` (\`owner_user_id\`)`);
    await q.query(`CREATE INDEX \`IDX_payments_provider_checkout\` ON \`payments\` (\`provider_checkout_id\`)`);

    // Money records must outlive the things they refer to: SET NULL, never CASCADE.
    await q.query(`ALTER TABLE \`payments\` ADD CONSTRAINT \`FK_payments_event\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\` (\`id\`) ON DELETE SET NULL`);
    await q.query(`ALTER TABLE \`payments\` ADD CONSTRAINT \`FK_payments_organization\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\` (\`id\`) ON DELETE SET NULL`);
    await q.query(`ALTER TABLE \`payments\` ADD CONSTRAINT \`FK_payments_owner_user\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL`);

    // At most ONE paid row per registration, and per organizer event fee. `paid_guard_key` is set
    // by PaymentLedgerService when a payment becomes PAID and is NULL otherwise; NULLs are exempt
    // from UNIQUE, so unlimited superseded/expired attempts remain allowed. (A generated column
    // would be neater but MySQL forbids one over columns that carry ON DELETE SET NULL/CASCADE
    // foreign keys.) Group payments (no single registration) have no key.
    await q.query(`
      ALTER TABLE \`payments\`
        ADD \`paid_guard_key\` varchar(80) NULL,
        ADD UNIQUE INDEX \`UQ_payments_paid_guard\` (\`paid_guard_key\`)
    `);
    await q.query(`
      UPDATE \`payments\` SET \`paid_guard_key\` = CONCAT('reg:', \`registration_id\`)
       WHERE \`status\` = 'paid' AND \`registration_id\` IS NOT NULL
    `);

    await q.query(`
      CREATE TABLE \`payment_webhook_events\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`provider_event_id\` varchar(100) NOT NULL,
        \`event_type\` varchar(100) NOT NULL,
        \`payment_id\` bigint NULL,
        \`status\` enum('received','processed','ignored','failed') NOT NULL DEFAULT 'received',
        \`detail\` varchar(500) NULL,
        \`payload\` json NOT NULL,
        \`received_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`processed_at\` datetime NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_payment_webhook_events_provider_event\` (\`provider_event_id\`),
        KEY \`IDX_payment_webhook_events_payment\` (\`payment_id\`),
        CONSTRAINT \`FK_payment_webhook_events_payment\` FOREIGN KEY (\`payment_id\`) REFERENCES \`payments\` (\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await q.query(`
      CREATE TABLE \`payment_status_logs\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`payment_id\` bigint NOT NULL,
        \`from_status\` varchar(32) NULL,
        \`to_status\` varchar(32) NOT NULL,
        \`source\` varchar(16) NOT NULL,
        \`note\` varchar(255) NULL,
        \`metadata\` json NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        KEY \`IDX_payment_status_logs_payment\` (\`payment_id\`),
        CONSTRAINT \`FK_payment_status_logs_payment\` FOREIGN KEY (\`payment_id\`) REFERENCES \`payments\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    // No default row on purpose: until an admin sets a fee, publishing needs no organizer fee.
    await q.query(`
      CREATE TABLE \`organizer_fee_configs\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`amount_centavos\` bigint NOT NULL,
        \`currency\` varchar(3) NOT NULL DEFAULT 'PHP',
        \`description\` varchar(255) NULL,
        \`is_active\` tinyint NOT NULL DEFAULT 1,
        \`effective_from\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`created_by_user_id\` bigint NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE `organizer_fee_configs`');
    await q.query('DROP TABLE `payment_status_logs`');
    await q.query('DROP TABLE `payment_webhook_events`');

    await q.query('ALTER TABLE `payments` DROP INDEX `UQ_payments_paid_guard`, DROP COLUMN `paid_guard_key`');
    await q.query('ALTER TABLE `payments` DROP FOREIGN KEY `FK_payments_owner_user`');
    await q.query('ALTER TABLE `payments` DROP FOREIGN KEY `FK_payments_organization`');
    await q.query('ALTER TABLE `payments` DROP FOREIGN KEY `FK_payments_event`');
    await q.query('DROP INDEX `IDX_payments_provider_checkout` ON `payments`');
    await q.query('DROP INDEX `IDX_payments_owner` ON `payments`');
    await q.query('DROP INDEX `IDX_payments_event` ON `payments`');
    await q.query('DROP INDEX `IDX_payments_purpose_status` ON `payments`');

    // Organizer-fee rows have no registration and cannot exist in the old shape; 'expired' did not
    // exist in the old enum. Both are removed/mapped so the revert cannot fail on new data.
    await q.query(`DELETE FROM \`payments\` WHERE \`purpose\` = 'organizer_event_creation'`);
    await q.query(`UPDATE \`payments\` SET \`status\` = 'cancelled' WHERE \`status\` = 'expired'`);
    await q.query(`
      ALTER TABLE \`payments\`
        DROP COLUMN \`updated_at\`,
        DROP COLUMN \`reconciliation_note\`,
        DROP COLUMN \`needs_reconciliation\`,
        DROP COLUMN \`expires_at\`,
        DROP COLUMN \`payment_method\`,
        DROP COLUMN \`currency\`,
        DROP COLUMN \`amount_centavos\`,
        DROP COLUMN \`checkout_url\`,
        DROP COLUMN \`provider_reference_number\`,
        DROP COLUMN \`owner_user_id\`,
        DROP COLUMN \`organization_id\`,
        DROP COLUMN \`event_id\`,
        DROP COLUMN \`purpose\`,
        MODIFY \`status\` enum('pending','paid','failed','cancelled','refunded') NOT NULL DEFAULT 'pending'
    `);
  }
}
