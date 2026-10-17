import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1789434809940 implements MigrationInterface {
    name = 'InitialSchema1789434809940'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`runner_profiles\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`user_id\` bigint NOT NULL, \`first_name\` varchar(255) NOT NULL, \`last_name\` varchar(255) NOT NULL, \`birthday\` date NULL, \`gender\` enum ('male', 'female') NULL, \`avatar_url\` varchar(255) NULL, \`shirt_size_default\` varchar(255) NULL, \`runner_since\` date NULL, UNIQUE INDEX \`REL_d4b6f2c6b8dab87087f0c9be0a\` (\`user_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`event_prizes\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`event_id\` bigint NOT NULL, \`category_id\` bigint NULL, \`position\` varchar(255) NOT NULL, \`amount\` decimal(10,2) NULL, \`description\` varchar(255) NULL, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`payments\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`registration_id\` bigint NOT NULL, \`provider\` varchar(255) NOT NULL DEFAULT 'paymongo', \`provider_payment_id\` varchar(255) NULL, \`provider_checkout_id\` varchar(255) NULL, \`registration_fee\` decimal(10,2) NOT NULL, \`platform_fee\` decimal(10,2) NOT NULL, \`total_amount\` decimal(10,2) NOT NULL, \`status\` enum ('pending', 'paid', 'failed', 'cancelled', 'refunded') NOT NULL DEFAULT 'pending', \`webhook_payload\` json NULL, \`paid_at\` datetime NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_9670987a405c3f3a93b3ac08a4\` (\`provider_payment_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`check_ins\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`registration_id\` bigint NOT NULL, \`checked_in_by_user_id\` bigint NOT NULL, \`checked_in_at\` datetime NOT NULL, \`device_info\` varchar(255) NULL, UNIQUE INDEX \`IDX_ec62eb9e9e2b46305f66e50272\` (\`registration_id\`), UNIQUE INDEX \`REL_ec62eb9e9e2b46305f66e50272\` (\`registration_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`personal_bests\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`user_id\` bigint NOT NULL, \`distance_km\` decimal(6,2) NOT NULL, \`best_time\` time NOT NULL, \`result_id\` bigint NOT NULL, \`achieved_at\` datetime NOT NULL, UNIQUE INDEX \`IDX_f8f5815ee675f27b40263770b4\` (\`user_id\`, \`distance_km\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`results\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`registration_id\` bigint NOT NULL, \`official_time\` time NULL, \`gun_time\` time NULL, \`chip_time\` time NULL, \`pace_per_km\` varchar(255) NULL, \`distance_km\` decimal(6,2) NOT NULL, \`overall_rank\` int NULL, \`category_rank\` int NULL, \`age_group_rank\` int NULL, \`is_verified\` tinyint NOT NULL DEFAULT 0, \`published_at\` datetime NULL, UNIQUE INDEX \`IDX_6f47fa12074c620877f20aead5\` (\`registration_id\`), UNIQUE INDEX \`REL_6f47fa12074c620877f20aead5\` (\`registration_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`certificates\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`registration_id\` bigint NOT NULL, \`certificate_url\` varchar(255) NOT NULL, \`generated_at\` datetime NOT NULL, UNIQUE INDEX \`IDX_2709475ae00f4c6d19b976e3d9\` (\`registration_id\`), UNIQUE INDEX \`REL_2709475ae00f4c6d19b976e3d9\` (\`registration_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`registrations\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`registration_code\` varchar(255) NOT NULL, \`event_id\` bigint NOT NULL, \`category_id\` bigint NOT NULL, \`runner_user_id\` bigint NOT NULL, \`first_name\` varchar(255) NOT NULL, \`last_name\` varchar(255) NOT NULL, \`birthday\` date NOT NULL, \`gender\` enum ('male', 'female') NOT NULL, \`mobile_number\` varchar(255) NOT NULL, \`email\` varchar(255) NOT NULL, \`address\` varchar(255) NULL, \`emergency_contact_name\` varchar(255) NOT NULL, \`emergency_contact_number\` varchar(255) NOT NULL, \`shirt_size\` varchar(255) NULL, \`bib_number\` varchar(255) NULL, \`qr_token\` varchar(255) NULL, \`status\` enum ('pending_payment', 'registered', 'cancelled', 'checked_in', 'completed') NOT NULL DEFAULT 'pending_payment', \`registered_at\` datetime NULL, UNIQUE INDEX \`IDX_3d9f6860c4a9b4fdc397ad4cc0\` (\`registration_code\`), UNIQUE INDEX \`IDX_538b49f36d4183a8dca4c62fca\` (\`qr_token\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`event_categories\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`event_id\` bigint NOT NULL, \`name\` varchar(255) NOT NULL, \`distance_km\` decimal(6,2) NOT NULL, \`price\` decimal(10,2) NOT NULL, \`slots_total\` int NOT NULL, \`slots_remaining\` int NOT NULL, \`min_age\` int NULL, \`max_age\` int NULL, \`gender_restriction\` enum ('all', 'male', 'female') NOT NULL DEFAULT 'all', PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`event_freebies\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`event_id\` bigint NOT NULL, \`name\` varchar(255) NOT NULL, \`is_custom\` tinyint NOT NULL DEFAULT 0, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`event_checkpoints\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`event_id\` bigint NOT NULL, \`type\` enum ('start', 'checkpoint', 'water', 'medical', 'finish') NOT NULL, \`name\` varchar(255) NOT NULL, \`sequence_order\` int NOT NULL, \`lat\` decimal(10,6) NULL, \`lng\` decimal(10,6) NULL, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`events\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`organization_id\` bigint NOT NULL, \`name\` varchar(255) NOT NULL, \`description\` text NULL, \`banner_url\` varchar(255) NULL, \`event_date\` date NOT NULL, \`registration_start\` datetime NOT NULL, \`registration_end\` datetime NOT NULL, \`venue\` varchar(255) NOT NULL, \`location\` varchar(255) NOT NULL, \`assembly_time\` time NULL, \`starting_time\` time NULL, \`contact_email\` varchar(255) NULL, \`contact_number\` varchar(255) NULL, \`status\` enum ('draft', 'published', 'reg_open', 'reg_closed', 'completed', 'cancelled') NOT NULL DEFAULT 'draft', \`route_image_url\` varchar(255) NULL, \`route_description\` text NULL, \`route_distance_km\` decimal(6,2) NULL, \`route_elevation_m\` int NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`platform_fee_configs\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`organization_id\` bigint NULL, \`fee_type\` enum ('fixed', 'percentage', 'fixed_plus_percentage') NOT NULL, \`fixed_amount\` decimal(10,2) NULL, \`percentage\` decimal(5,2) NULL, \`is_active\` tinyint NOT NULL DEFAULT 1, \`effective_from\` datetime NOT NULL, UNIQUE INDEX \`REL_d2313263cd33764bcc6ab6e39c\` (\`organization_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`organizations\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`owner_user_id\` bigint NOT NULL, \`name\` varchar(255) NOT NULL, \`logo_url\` varchar(255) NULL, \`description\` text NULL, \`website\` varchar(255) NULL, \`social_links\` json NULL, \`contact_email\` varchar(255) NULL, \`contact_number\` varchar(255) NULL, \`status\` enum ('pending', 'active', 'suspended') NOT NULL DEFAULT 'pending', \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX \`REL_a8afaf18799fd187cbe8e998dc\` (\`owner_user_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`achievements\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`code\` varchar(255) NOT NULL, \`name\` varchar(255) NOT NULL, \`description\` text NULL, \`icon\` varchar(255) NULL, \`criteria_type\` enum ('distance_total', 'event_count', 'podium', 'early_run', 'first_run', 'pb') NOT NULL, \`criteria_value\` decimal(10,2) NOT NULL, UNIQUE INDEX \`IDX_cd74882f69ff37d7330e89c63d\` (\`code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`runner_achievements\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`user_id\` bigint NOT NULL, \`achievement_id\` bigint NOT NULL, \`progress_current\` decimal(10,2) NOT NULL DEFAULT '0.00', \`progress_target\` decimal(10,2) NOT NULL, \`earned_at\` datetime NULL, UNIQUE INDEX \`IDX_71f2b95384123ae6a299625e9f\` (\`user_id\`, \`achievement_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`notifications\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`user_id\` bigint NOT NULL, \`type\` varchar(255) NOT NULL, \`title\` varchar(255) NOT NULL, \`body\` text NOT NULL, \`is_read\` tinyint NOT NULL DEFAULT 0, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`users\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`email\` varchar(255) NOT NULL, \`password_hash\` varchar(255) NULL, \`phone\` varchar(255) NULL, \`role\` enum ('admin', 'organizer', 'runner') NOT NULL DEFAULT 'runner', \`is_active\` tinyint NOT NULL DEFAULT 1, \`google_id\` varchar(255) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_97672ac88f789774dd47f7c8be\` (\`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`runner_profiles\` ADD CONSTRAINT \`FK_d4b6f2c6b8dab87087f0c9be0af\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`event_prizes\` ADD CONSTRAINT \`FK_d5116b95632cc0d4cd8fd4a7093\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`event_prizes\` ADD CONSTRAINT \`FK_666aadf9bc3aaa34e47d21a299b\` FOREIGN KEY (\`category_id\`) REFERENCES \`event_categories\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`payments\` ADD CONSTRAINT \`FK_dcf8450959aadff1b025a2434d7\` FOREIGN KEY (\`registration_id\`) REFERENCES \`registrations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`check_ins\` ADD CONSTRAINT \`FK_ec62eb9e9e2b46305f66e50272c\` FOREIGN KEY (\`registration_id\`) REFERENCES \`registrations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`check_ins\` ADD CONSTRAINT \`FK_fd2b484fb3604c6808322c88e16\` FOREIGN KEY (\`checked_in_by_user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`personal_bests\` ADD CONSTRAINT \`FK_c95759bb885d71379bf57116264\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`personal_bests\` ADD CONSTRAINT \`FK_3889be07981e596d05df46d812d\` FOREIGN KEY (\`result_id\`) REFERENCES \`results\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`results\` ADD CONSTRAINT \`FK_6f47fa12074c620877f20aead50\` FOREIGN KEY (\`registration_id\`) REFERENCES \`registrations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`certificates\` ADD CONSTRAINT \`FK_2709475ae00f4c6d19b976e3d9e\` FOREIGN KEY (\`registration_id\`) REFERENCES \`registrations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`registrations\` ADD CONSTRAINT \`FK_c082d66f7080c743a96c1e91807\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`registrations\` ADD CONSTRAINT \`FK_c03303e587086fbdbf7f3c4d601\` FOREIGN KEY (\`category_id\`) REFERENCES \`event_categories\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`registrations\` ADD CONSTRAINT \`FK_1ca5f051ba7614db39449e250b1\` FOREIGN KEY (\`runner_user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`event_categories\` ADD CONSTRAINT \`FK_c78c7b670b392b79ee76f01b675\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`event_freebies\` ADD CONSTRAINT \`FK_448e7739083ea138aaefa6239ed\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`event_checkpoints\` ADD CONSTRAINT \`FK_c6025683f1ae6dc0fd5a31a32ee\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`events\` ADD CONSTRAINT \`FK_8557ec49101496ab87be666d633\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`platform_fee_configs\` ADD CONSTRAINT \`FK_d2313263cd33764bcc6ab6e39c3\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`organizations\` ADD CONSTRAINT \`FK_a8afaf18799fd187cbe8e998dcd\` FOREIGN KEY (\`owner_user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`runner_achievements\` ADD CONSTRAINT \`FK_84d9a3151c056ad7e1dbccff01b\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`runner_achievements\` ADD CONSTRAINT \`FK_1237dc615eace69db6bdeb57743\` FOREIGN KEY (\`achievement_id\`) REFERENCES \`achievements\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`notifications\` ADD CONSTRAINT \`FK_9a8a82462cab47c73d25f49261f\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`notifications\` DROP FOREIGN KEY \`FK_9a8a82462cab47c73d25f49261f\``);
        await queryRunner.query(`ALTER TABLE \`runner_achievements\` DROP FOREIGN KEY \`FK_1237dc615eace69db6bdeb57743\``);
        await queryRunner.query(`ALTER TABLE \`runner_achievements\` DROP FOREIGN KEY \`FK_84d9a3151c056ad7e1dbccff01b\``);
        await queryRunner.query(`ALTER TABLE \`organizations\` DROP FOREIGN KEY \`FK_a8afaf18799fd187cbe8e998dcd\``);
        await queryRunner.query(`ALTER TABLE \`platform_fee_configs\` DROP FOREIGN KEY \`FK_d2313263cd33764bcc6ab6e39c3\``);
        await queryRunner.query(`ALTER TABLE \`events\` DROP FOREIGN KEY \`FK_8557ec49101496ab87be666d633\``);
        await queryRunner.query(`ALTER TABLE \`event_checkpoints\` DROP FOREIGN KEY \`FK_c6025683f1ae6dc0fd5a31a32ee\``);
        await queryRunner.query(`ALTER TABLE \`event_freebies\` DROP FOREIGN KEY \`FK_448e7739083ea138aaefa6239ed\``);
        await queryRunner.query(`ALTER TABLE \`event_categories\` DROP FOREIGN KEY \`FK_c78c7b670b392b79ee76f01b675\``);
        await queryRunner.query(`ALTER TABLE \`registrations\` DROP FOREIGN KEY \`FK_1ca5f051ba7614db39449e250b1\``);
        await queryRunner.query(`ALTER TABLE \`registrations\` DROP FOREIGN KEY \`FK_c03303e587086fbdbf7f3c4d601\``);
        await queryRunner.query(`ALTER TABLE \`registrations\` DROP FOREIGN KEY \`FK_c082d66f7080c743a96c1e91807\``);
        await queryRunner.query(`ALTER TABLE \`certificates\` DROP FOREIGN KEY \`FK_2709475ae00f4c6d19b976e3d9e\``);
        await queryRunner.query(`ALTER TABLE \`results\` DROP FOREIGN KEY \`FK_6f47fa12074c620877f20aead50\``);
        await queryRunner.query(`ALTER TABLE \`personal_bests\` DROP FOREIGN KEY \`FK_3889be07981e596d05df46d812d\``);
        await queryRunner.query(`ALTER TABLE \`personal_bests\` DROP FOREIGN KEY \`FK_c95759bb885d71379bf57116264\``);
        await queryRunner.query(`ALTER TABLE \`check_ins\` DROP FOREIGN KEY \`FK_fd2b484fb3604c6808322c88e16\``);
        await queryRunner.query(`ALTER TABLE \`check_ins\` DROP FOREIGN KEY \`FK_ec62eb9e9e2b46305f66e50272c\``);
        await queryRunner.query(`ALTER TABLE \`payments\` DROP FOREIGN KEY \`FK_dcf8450959aadff1b025a2434d7\``);
        await queryRunner.query(`ALTER TABLE \`event_prizes\` DROP FOREIGN KEY \`FK_666aadf9bc3aaa34e47d21a299b\``);
        await queryRunner.query(`ALTER TABLE \`event_prizes\` DROP FOREIGN KEY \`FK_d5116b95632cc0d4cd8fd4a7093\``);
        await queryRunner.query(`ALTER TABLE \`runner_profiles\` DROP FOREIGN KEY \`FK_d4b6f2c6b8dab87087f0c9be0af\``);
        await queryRunner.query(`DROP INDEX \`IDX_97672ac88f789774dd47f7c8be\` ON \`users\``);
        await queryRunner.query(`DROP TABLE \`users\``);
        await queryRunner.query(`DROP TABLE \`notifications\``);
        await queryRunner.query(`DROP INDEX \`IDX_71f2b95384123ae6a299625e9f\` ON \`runner_achievements\``);
        await queryRunner.query(`DROP TABLE \`runner_achievements\``);
        await queryRunner.query(`DROP INDEX \`IDX_cd74882f69ff37d7330e89c63d\` ON \`achievements\``);
        await queryRunner.query(`DROP TABLE \`achievements\``);
        await queryRunner.query(`DROP INDEX \`REL_a8afaf18799fd187cbe8e998dc\` ON \`organizations\``);
        await queryRunner.query(`DROP TABLE \`organizations\``);
        await queryRunner.query(`DROP INDEX \`REL_d2313263cd33764bcc6ab6e39c\` ON \`platform_fee_configs\``);
        await queryRunner.query(`DROP TABLE \`platform_fee_configs\``);
        await queryRunner.query(`DROP TABLE \`events\``);
        await queryRunner.query(`DROP TABLE \`event_checkpoints\``);
        await queryRunner.query(`DROP TABLE \`event_freebies\``);
        await queryRunner.query(`DROP TABLE \`event_categories\``);
        await queryRunner.query(`DROP INDEX \`IDX_538b49f36d4183a8dca4c62fca\` ON \`registrations\``);
        await queryRunner.query(`DROP INDEX \`IDX_3d9f6860c4a9b4fdc397ad4cc0\` ON \`registrations\``);
        await queryRunner.query(`DROP TABLE \`registrations\``);
        await queryRunner.query(`DROP INDEX \`REL_2709475ae00f4c6d19b976e3d9\` ON \`certificates\``);
        await queryRunner.query(`DROP INDEX \`IDX_2709475ae00f4c6d19b976e3d9\` ON \`certificates\``);
        await queryRunner.query(`DROP TABLE \`certificates\``);
        await queryRunner.query(`DROP INDEX \`REL_6f47fa12074c620877f20aead5\` ON \`results\``);
        await queryRunner.query(`DROP INDEX \`IDX_6f47fa12074c620877f20aead5\` ON \`results\``);
        await queryRunner.query(`DROP TABLE \`results\``);
        await queryRunner.query(`DROP INDEX \`IDX_f8f5815ee675f27b40263770b4\` ON \`personal_bests\``);
        await queryRunner.query(`DROP TABLE \`personal_bests\``);
        await queryRunner.query(`DROP INDEX \`REL_ec62eb9e9e2b46305f66e50272\` ON \`check_ins\``);
        await queryRunner.query(`DROP INDEX \`IDX_ec62eb9e9e2b46305f66e50272\` ON \`check_ins\``);
        await queryRunner.query(`DROP TABLE \`check_ins\``);
        await queryRunner.query(`DROP INDEX \`IDX_9670987a405c3f3a93b3ac08a4\` ON \`payments\``);
        await queryRunner.query(`DROP TABLE \`payments\``);
        await queryRunner.query(`DROP TABLE \`event_prizes\``);
        await queryRunner.query(`DROP INDEX \`REL_d4b6f2c6b8dab87087f0c9be0a\` ON \`runner_profiles\``);
        await queryRunner.query(`DROP TABLE \`runner_profiles\``);
    }

}
