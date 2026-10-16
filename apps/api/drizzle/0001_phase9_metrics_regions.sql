CREATE TYPE "public"."region" AS ENUM('eu', 'uk', 'us', 'other');--> statement-breakpoint
CREATE TABLE "review_times" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"ms" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "region" "region" DEFAULT 'eu' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "setup_result" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_times" ADD CONSTRAINT "review_times_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_times" ADD CONSTRAINT "review_times_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_times_session" ON "review_times" USING btree ("session_id");