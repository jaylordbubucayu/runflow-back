import { MigrationInterface, QueryRunner } from 'typeorm';

/** users.id is BIGINT(20) signed; columns are snake_case to match the rest of the schema. */
export class CreatePasswordResetChallenges1791590400000 implements MigrationInterface {
  name = 'CreatePasswordResetChallenges1791590400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`password_reset_challenges\` (
        \`id\` VARCHAR(36) NOT NULL,
        \`user_id\` BIGINT(20) NOT NULL,
        \`otp_hash\` CHAR(64) NOT NULL,
        \`expires_at\` DATETIME NOT NULL,
        \`attempts\` INT NOT NULL DEFAULT 0,
        \`verified_at\` DATETIME NULL,
        \`reset_token_hash\` CHAR(64) NULL,
        \`reset_token_expires_at\` DATETIME NULL,
        \`consumed_at\` DATETIME NULL,
        \`created_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_prc_user_created\` (\`user_id\`, \`created_at\`),
        INDEX \`idx_prc_reset_token_hash\` (\`reset_token_hash\`),
        CONSTRAINT \`fk_prc_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS \`password_reset_challenges\``);
  }
}