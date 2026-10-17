import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOauthLoginCodes1791500000000 implements MigrationInterface {
  name = 'AddOauthLoginCodes1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`oauth_login_codes\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`code_hash\` char(64) NOT NULL,
        \`user_id\` bigint NOT NULL,
        \`return_to\` varchar(255) NULL,
        \`expires_at\` datetime NOT NULL,
        \`consumed_at\` datetime NULL,
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_oauth_login_codes_code_hash\` (\`code_hash\`),
        KEY \`IDX_oauth_login_codes_expires_at\` (\`expires_at\`),
        CONSTRAINT \`FK_oauth_login_codes_user\`
          FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `oauth_login_codes`');
  }
}
