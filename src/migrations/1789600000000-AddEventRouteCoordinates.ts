import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventRouteCoordinates1789600000000
  implements MigrationInterface
{
  name = 'AddEventRouteCoordinates1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `events` ADD `route_coordinates` json NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `events` DROP COLUMN `route_coordinates`',
    );
  }
}
