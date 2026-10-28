CREATE TABLE `inbound_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`event_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_source_unique` ON `inbound_updates` (`channel_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`task_id` integer,
	`key` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`message_id` text,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_key_unique` ON `outbox` (`key`);--> statement-breakpoint
CREATE INDEX `outbox_pending` ON `outbox` (`status`,`retry_at`,`id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`inbound_id` integer NOT NULL,
	`cwd` text NOT NULL,
	`session_id` text,
	`run_id` text,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inbound_id`) REFERENCES `inbound_updates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_inbound_id_unique` ON `tasks` (`inbound_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_single_active` ON `tasks` ((1)) WHERE "tasks"."finished_at" is null;--> statement-breakpoint
CREATE INDEX `tasks_channel_created` ON `tasks` (`channel_id`,`id`);--> statement-breakpoint
ALTER TABLE `channels` ADD `cwd` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `paused` integer DEFAULT false NOT NULL;