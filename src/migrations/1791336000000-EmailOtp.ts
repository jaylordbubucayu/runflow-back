// src/migrations/1791336000000-EmailOtp.ts
import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class EmailOtp1791336000000 implements MigrationInterface {
  name = 'EmailOtp1791336000000';

  public async up(q: QueryRunner): Promise<void> {
    // Old user-keyed version (if a previous attempt created it).
    await q.dropTable('email_verifications', true, true, true);

    await q.createTable(
      new Table({
        name: 'email_verifications',
        engine: 'InnoDB',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'email', type: 'varchar', length: '254' },
          { name: 'codeHash', type: 'varchar', length: '64' },
          { name: 'expiresAt', type: 'datetime', precision: 6 },
          { name: 'attempts', type: 'int', default: 0 },
          { name: 'consumedAt', type: 'datetime', precision: 6, isNullable: true },
          { name: 'createdAt', type: 'datetime', precision: 6 },
        ],
      }),
    );
    await q.createIndex(
      'email_verifications',
      new TableIndex({ name: 'IDX_email_verifications_email', columnNames: ['email'] }),
    );

    // Every account is now created already verified, so these are no longer needed.
    if (await q.hasColumn('users', 'isEmailVerified')) await q.dropColumn('users', 'isEmailVerified');
    if (await q.hasColumn('users', 'emailVerifiedAt')) await q.dropColumn('users', 'emailVerifiedAt');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.dropTable('email_verifications', true, true, true);
  }
}