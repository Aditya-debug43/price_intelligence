ALTER TABLE "product_matches" ADD COLUMN "pack_attested_by" uuid;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "pack_attested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "pack_attestation_note" text;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_pack_attested_by_users_id_fk" FOREIGN KEY ("pack_attested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;