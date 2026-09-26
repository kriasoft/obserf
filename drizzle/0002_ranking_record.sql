ALTER TABLE `assessments` DROP COLUMN `score`;--> statement-breakpoint
ALTER TABLE `triage` ADD `dismissal_category` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `inbox` text;--> statement-breakpoint
ALTER TABLE `triage` ADD `first_decided_hidden` integer;--> statement-breakpoint
-- Decisions made before this column existed were made with the reason shown:
-- the inbox had no way to hide it. Recorded as such, so reopening one cannot
-- turn a later review into its first decision.
UPDATE `triage` SET `first_decided_hidden` = 0 WHERE `status` != 'new';--> statement-breakpoint
ALTER TABLE `assessments` ADD `run_id` integer REFERENCES runs(id);