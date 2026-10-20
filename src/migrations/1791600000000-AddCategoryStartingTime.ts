import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-category start time (wave start). Nullable: NULL = use the event's own starting_time. */
export class AddCategoryStartingTime1791600000000 implements MigrationInterface {
  name = 'AddCategoryStartingTime1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `event_categories` ADD `starting_time` time NULL AFTER `gender_restriction`',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `event_categories` DROP COLUMN `starting_time`');
  }
}
