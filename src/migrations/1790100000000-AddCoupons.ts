import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCoupons1790100000000 implements MigrationInterface {
  name = 'AddCoupons1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`event_coupons\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`event_id\` bigint NOT NULL,
        \`code\` varchar(32) NOT NULL,
        \`discount_type\` enum('percentage','fixed') NOT NULL,
        \`discount_value\` decimal(10,2) NOT NULL,
        \`max_uses\` int NULL,
        \`uses_count\` int NOT NULL DEFAULT 0,
        \`max_uses_per_user\` int NOT NULL DEFAULT 1,
        \`valid_from\` datetime NULL,
        \`valid_until\` datetime NULL,
        \`is_active\` tinyint NOT NULL DEFAULT 1,
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_event_coupons_event_code\` (\`event_id\`, \`code\`),
        CONSTRAINT \`FK_event_coupons_event\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);

    // Discount is locked onto the registration at creation time (not recomputed at checkout), so
    // it can't drift if the coupon's terms change or it's deactivated between registering and
    // paying. coupon_code is kept even if the coupon itself is later deleted (SET NULL on the
    // coupon_id FK, not on this column) so the registration's own history stays intact.
    await queryRunner.query(`
      ALTER TABLE \`registrations\`
        ADD \`coupon_id\` bigint NULL,
        ADD \`coupon_code\` varchar(32) NULL,
        ADD \`discount_amount\` decimal(10,2) NULL,
        ADD CONSTRAINT \`FK_registrations_coupon\` FOREIGN KEY (\`coupon_id\`) REFERENCES \`event_coupons\` (\`id\`) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `registrations` ' +
        'DROP FOREIGN KEY `FK_registrations_coupon`, ' +
        'DROP COLUMN `discount_amount`, ' +
        'DROP COLUMN `coupon_code`, ' +
        'DROP COLUMN `coupon_id`',
    );
    await queryRunner.query('DROP TABLE `event_coupons`');
  }
}
