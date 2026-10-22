import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Organizer payouts via PayMongo.
 *
 *  - organizer_payout_accounts: gains the PayMongo linked-account link (`org_…` id returned by
 *    POST /v2/accounts, plus its activation status) and `bank_code` (the BIC PayMongo transfers
 *    need to address the destination bank / e-wallet).
 *  - organizer_payouts: one row per transfer sent to an organizer. The organizer's balance is
 *    derived (paid registration fees - succeeded/pending payouts), so this table is also the
 *    reservation ledger that stops the same money being withdrawn twice.
 *
 * Additive only: nothing is dropped and no existing data is rewritten.
 */
export class OrganizerPayouts1791800000000 implements MigrationInterface {
  name = 'OrganizerPayouts1791800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE \`organizer_payout_accounts\`
        ADD \`bank_code\` varchar(32) NULL,
        ADD \`paymongo_account_id\` varchar(64) NULL,
        ADD \`paymongo_activation_status\` varchar(32) NULL,
        ADD \`paymongo_connected_at\` datetime NULL,
        ADD UNIQUE INDEX \`UQ_organizer_payout_accounts_paymongo_account\` (\`paymongo_account_id\`)
    `);

    // Money records outlive what they refer to: SET NULL, never CASCADE (same rule as payments).
    await q.query(`
      CREATE TABLE \`organizer_payouts\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`organization_id\` bigint NULL,
        \`payout_account_id\` bigint NULL,
        \`amount_centavos\` bigint NOT NULL,
        \`currency\` varchar(3) NOT NULL DEFAULT 'PHP',
        \`status\` enum('pending','succeeded','failed') NOT NULL DEFAULT 'pending',
        \`provider\` varchar(32) NOT NULL,
        \`reference_number\` varchar(64) NOT NULL,
        \`destination_bank_code\` varchar(32) NULL,
        \`destination_last4\` varchar(4) NULL,
        \`destination_name\` varchar(255) NULL,
        \`paymongo_account_id\` varchar(64) NULL,
        \`paymongo_batch_id\` varchar(64) NULL,
        \`paymongo_transfer_id\` varchar(64) NULL,
        \`failure_reason\` varchar(255) NULL,
        \`needs_review\` tinyint NOT NULL DEFAULT 0,
        \`requested_by_user_id\` bigint NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`completed_at\` datetime NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_organizer_payouts_reference\` (\`reference_number\`),
        KEY \`IDX_organizer_payouts_org_status\` (\`organization_id\`, \`status\`),
        CONSTRAINT \`FK_organizer_payouts_organization\`
          FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\` (\`id\`) ON DELETE SET NULL,
        CONSTRAINT \`FK_organizer_payouts_account\`
          FOREIGN KEY (\`payout_account_id\`) REFERENCES \`organizer_payout_accounts\` (\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE `organizer_payouts`');
    await q.query(`
      ALTER TABLE \`organizer_payout_accounts\`
        DROP INDEX \`UQ_organizer_payout_accounts_paymongo_account\`,
        DROP COLUMN \`paymongo_connected_at\`,
        DROP COLUMN \`paymongo_activation_status\`,
        DROP COLUMN \`paymongo_account_id\`,
        DROP COLUMN \`bank_code\`
    `);
  }
}
