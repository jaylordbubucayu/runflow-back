import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateEmailLogs1791290011000 implements MigrationInterface {
  name = 'CreateEmailLogs1791290011000';

  public async up(q: QueryRunner): Promise<void> {
    await q.createTable(
      new Table({
        name: 'email_logs',
        engine: 'InnoDB',
        columns: [
          // TypeORM generates the UUID in the app for MySQL, so no DB default is needed
          { name: 'id', type: 'varchar', length: '36', isPrimary: true },
          { name: 'message_id', type: 'varchar', length: '255', isNullable: true },
          { name: 'status', type: 'varchar', length: '20', default: "'pending'" },
          { name: 'provider', type: 'varchar', length: '50' },
          { name: 'from_address', type: 'varchar', length: '320' },
          { name: 'to_addresses', type: 'json' },
          { name: 'cc_addresses', type: 'json', isNullable: true },
          { name: 'bcc_addresses', type: 'json', isNullable: true },
          { name: 'subject', type: 'varchar', length: '200' },
          { name: 'template', type: 'varchar', length: '100', isNullable: true },
          { name: 'body_hash', type: 'char', length: '64', isNullable: true },
          { name: 'body', type: 'mediumtext', isNullable: true },
          { name: 'attachment_count', type: 'int', default: 0 },
          { name: 'attempts', type: 'int', default: 0 },
          { name: 'accepted', type: 'json', isNullable: true },
          { name: 'rejected', type: 'json', isNullable: true },
          { name: 'error', type: 'varchar', length: '500', isNullable: true },
          { name: 'metadata', type: 'json', isNullable: true },
          { name: 'created_at', type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)' },
          { name: 'sent_at', type: 'datetime', precision: 6, isNullable: true },
        ],
      }),
      true,
    );

    await q.createIndex('email_logs', new TableIndex({ name: 'idx_email_logs_message_id', columnNames: ['message_id'] }));
    await q.createIndex(
      'email_logs',
      new TableIndex({ name: 'idx_email_logs_status_created', columnNames: ['status', 'created_at'] }),
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.dropIndex('email_logs', 'idx_email_logs_status_created');
    await q.dropIndex('email_logs', 'idx_email_logs_message_id');
    await q.dropTable('email_logs');
  }
}
