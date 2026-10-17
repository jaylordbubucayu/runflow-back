import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventCategoryRoute1789800000000 implements MigrationInterface {
  name = 'AddEventCategoryRoute1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `event_categories` ' +
        'ADD `route_image_url` varchar(255) NULL, ' +
        'ADD `route_coordinates` json NULL, ' +
        'ADD `route_description` text NULL, ' +
        'ADD `route_distance_km` decimal(6,2) NULL, ' +
        'ADD `route_elevation_m` int NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `event_categories` ' +
        'DROP COLUMN `route_image_url`, ' +
        'DROP COLUMN `route_coordinates`, ' +
        'DROP COLUMN `route_description`, ' +
        'DROP COLUMN `route_distance_km`, ' +
        'DROP COLUMN `route_elevation_m`',
    );
  }
}
