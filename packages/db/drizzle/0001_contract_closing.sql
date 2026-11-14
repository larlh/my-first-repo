ALTER TABLE "assets" ADD COLUMN "purpose" text DEFAULT 'library' NOT NULL;--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "progress" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "eta_sec" integer;--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "cutout_key" text;