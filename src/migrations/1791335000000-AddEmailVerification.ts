import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class AddEmailVerification1791335000000
  implements MigrationInterface
{
  name = 'AddEmailVerification1791335000000';

  public async up(q: QueryRunner): Promise<void> {
    // Verify users table exists
    const users = await q.getTable('users');

    if (!users) {
      throw new Error('Table "users" not found');
    }

    const idCol = users.findColumnByName('id');

    if (!idCol) {
      throw new Error('Column "users.id" not found');
    }

    // Add isEmailVerified
    if (!(await q.hasColumn('users', 'isEmailVerified'))) {
      await q.addColumn(
        'users',
        new TableColumn({
          name: 'isEmailVerified',
          type: 'tinyint',
          width: 1,
          isNullable: false,
          default: 0,
        }),
      );

      // Existing accounts are considered verified.
      await q.query(`
        UPDATE \`users\`
        SET \`isEmailVerified\` = 1
      `);
    }

    // Add emailVerifiedAt
    if (!(await q.hasColumn('users', 'emailVerifiedAt'))) {
      await q.addColumn(
        'users',
        new TableColumn({
          name: 'emailVerifiedAt',
          type: 'datetime',
          precision: 6,
          isNullable: true,
        }),
      );

      // Set verification timestamp for existing verified accounts.
      await q.query(`
        UPDATE \`users\`
        SET \`emailVerifiedAt\` = NOW(6)
        WHERE \`isEmailVerified\` = 1
      `);
    }

    // If the table already exists, don't recreate it.
    if (await q.hasTable('email_verifications')) {
      return;
    }

    // Create email_verifications table
    await q.createTable(
      new Table({
        name: 'email_verifications',
        engine: 'InnoDB',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },

          // IMPORTANT:
          // users.id is BIGINT NOT NULL.
          // Therefore userId must also be BIGINT NOT NULL.
          {
            name: 'userId',
            type: 'bigint',
            isNullable: false,
          },

          {
            name: 'codeHash',
            type: 'varchar',
            length: '64',
            isNullable: false,
          },

          {
            name: 'expiresAt',
            type: 'datetime',
            precision: 6,
            isNullable: false,
          },

          {
            name: 'attempts',
            type: 'int',
            isNullable: false,
            default: 0,
          },

          {
            name: 'consumedAt',
            type: 'datetime',
            precision: 6,
            isNullable: true,
          },

          {
            name: 'createdAt',
            type: 'datetime',
            precision: 6,
            isNullable: false,
            default: 'CURRENT_TIMESTAMP(6)',
          },
        ],
      }),
    );

    // Index userId
    await q.createIndex(
      'email_verifications',
      new TableIndex({
        name: 'IDX_email_verifications_user',
        columnNames: ['userId'],
      }),
    );

    // Foreign key: email_verifications.userId -> users.id
    await q.createForeignKey(
      'email_verifications',
      new TableForeignKey({
        name: 'FK_email_verifications_user',
        columnNames: ['userId'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await q.hasTable('email_verifications')) {
      await q.dropTable(
        'email_verifications',
        true,
        true,
        true,
      );
    }

    if (await q.hasColumn('users', 'emailVerifiedAt')) {
      await q.dropColumn('users', 'emailVerifiedAt');
    }

    if (await q.hasColumn('users', 'isEmailVerified')) {
      await q.dropColumn('users', 'isEmailVerified');
    }
  }
}
