import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventBannerUrls1789700000000 implements MigrationInterface {
  name = 'AddEventBannerUrls1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `events` ADD `banner_urls` json NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `events` DROP COLUMN `banner_urls`',
    );
  }
}