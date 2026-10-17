import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrganizerPayoutAccounts1789900000000
  implements MigrationInterface
{
  name = 'CreateOrganizerPayoutAccounts1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`organizer_payout_accounts\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`organization_id\` bigint NOT NULL,
        \`type\` enum('bank','wallet','card') NOT NULL,
        \`provider\` varchar(255) NOT NULL,
        \`account_holder_name\` varchar(255) NOT NULL,
        \`account_number_encrypted\` text NOT NULL,
        \`account_number_last4\` varchar(4) NOT NULL,
        \`status\` enum('pending','verified','failed') NOT NULL DEFAULT 'pending',
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_organizer_payout_accounts_organization_id\` (\`organization_id\`),
        CONSTRAINT \`FK_organizer_payout_accounts_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `organizer_payout_accounts`');
  }
}
