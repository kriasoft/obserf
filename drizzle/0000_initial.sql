CREATE TABLE `assessments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` integer NOT NULL,
	`model` text NOT NULL,
	`prompt_fingerprint` text NOT NULL,
	`relevance` integer NOT NULL,
	`intent` integer NOT NULL,
	`welcome` integer NOT NULL,
	`reach` integer NOT NULL,
	`opportunity` text,
	`disqualified` integer DEFAULT false NOT NULL,
	`reason` text NOT NULL,
	`score` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assessments_finding` ON `assessments` (`finding_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` integer NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drafts_finding` ON `drafts` (`finding_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`source_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`author` text,
	`venue` text NOT NULL,
	`published_at` integer,
	`metrics` text,
	`is_thread_comment` integer,
	`repository` text,
	`discovered_at` integer NOT NULL,
	`first_run_id` integer,
	`raw` text,
	FOREIGN KEY (`first_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_project_url` ON `findings` (`project`,`url`);--> statement-breakpoint
CREATE INDEX `findings_project_discovered` ON `findings` (`project`,`discovered_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`sources` text NOT NULL,
	`skipped` text,
	`candidates` integer DEFAULT 0 NOT NULL,
	`gated` text,
	`assessed` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost_usd` real DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `triage` (
	`finding_id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`note` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `triage_status` ON `triage` (`status`);