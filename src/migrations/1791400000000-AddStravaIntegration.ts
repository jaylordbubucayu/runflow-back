import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStravaIntegration1791400000000 implements MigrationInterface {
  name = 'AddStravaIntegration1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`strava_connections\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`user_id\` bigint NOT NULL,
        \`strava_athlete_id\` bigint NULL,
        \`athlete_display_name\` varchar(120) NULL,
        \`access_token_encrypted\` text NULL,
        \`refresh_token_encrypted\` text NULL,
        \`expires_at\` datetime NULL,
        \`scopes\` varchar(255) NOT NULL DEFAULT '',
        \`is_connected\` tinyint NOT NULL DEFAULT 0,
        \`disconnect_reason\` varchar(32) NULL,
        \`disconnected_at\` datetime NULL,
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_strava_connections_user_id\` (\`user_id\`),
        UNIQUE KEY \`UQ_strava_connections_athlete_id\` (\`strava_athlete_id\`),
        CONSTRAINT \`FK_strava_connections_user\`
          FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE \`strava_oauth_states\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`state_hash\` char(64) NOT NULL,
        \`user_id\` bigint NOT NULL,
        \`return_to\` varchar(255) NOT NULL,
        \`expires_at\` datetime NOT NULL,
        \`consumed_at\` datetime NULL,
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_strava_oauth_states_state_hash\` (\`state_hash\`),
        KEY \`IDX_strava_oauth_states_expires_at\` (\`expires_at\`),
        CONSTRAINT \`FK_strava_oauth_states_user\`
          FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE \`strava_activities\` (
        \`id\` bigint NOT NULL AUTO_INCREMENT,
        \`user_id\` bigint NOT NULL,
        \`registration_id\` bigint NOT NULL,
        \`strava_connection_id\` bigint NOT NULL,
        \`kind\` enum('manual','upload') NOT NULL,
        \`client_request_id\` varchar(64) NOT NULL,
        \`strava_activity_id\` bigint NULL,
        \`strava_upload_id\` bigint NULL,
        \`activity_type\` varchar(32) NULL,
        \`activity_name\` varchar(255) NULL,
        \`description\` text NULL,
        \`distance_meters\` decimal(10,2) NULL,
        \`moving_time_seconds\` int NULL,
        \`elapsed_time_seconds\` int NULL,
        \`start_date\` datetime NULL,
        \`status\` enum('pending','processing','completed','failed','needs_review') NOT NULL DEFAULT 'pending',
        \`error_code\` varchar(64) NULL,
        \`error_message\` varchar(255) NULL,
        \`retryable\` tinyint NOT NULL DEFAULT 0,
        \`file_sha256\` char(64) NULL,
        \`active_registration_key\` bigint NULL,
        \`active_file_key\` varchar(100) NULL,
        \`poll_attempts\` int NOT NULL DEFAULT 0,
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_strava_activities_user_request\` (\`user_id\`, \`client_request_id\`),
        UNIQUE KEY \`UQ_strava_activities_strava_activity_id\` (\`strava_activity_id\`),
        UNIQUE KEY \`UQ_strava_activities_active_registration\` (\`active_registration_key\`),
        UNIQUE KEY \`UQ_strava_activities_active_file\` (\`active_file_key\`),
        KEY \`IDX_strava_activities_user_created\` (\`user_id\`, \`created_at\`),
        KEY \`IDX_strava_activities_registration\` (\`registration_id\`),
        KEY \`IDX_strava_activities_status\` (\`status\`),
        CONSTRAINT \`FK_strava_activities_user\`
          FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`FK_strava_activities_registration\`
          FOREIGN KEY (\`registration_id\`) REFERENCES \`registrations\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`FK_strava_activities_connection\`
          FOREIGN KEY (\`strava_connection_id\`) REFERENCES \`strava_connections\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `strava_activities`');
    await queryRunner.query('DROP TABLE `strava_oauth_states`');
    await queryRunner.query('DROP TABLE `strava_connections`');
  }
}
