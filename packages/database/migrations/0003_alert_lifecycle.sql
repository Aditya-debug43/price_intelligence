ALTER TABLE "alerts" ADD COLUMN "evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "resolution_kind" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "resolution_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolution_evidence_id_evidence_id_fk" FOREIGN KEY ("resolution_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_unresolved_idx" ON "alerts" USING btree ("org_id","variant_id") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
-- Backfill for alerts raised before lifecycle tracking existed. Alerts fire only on transitions, so the NEXT stock alert for the same item
-- (a restock, or a new low/out-of-stock episode) is real evidence that the earlier condition ended, and its time is when it ended.
UPDATE "alerts" a SET "resolved_at" = n."at", "resolution_kind" = 'automatic',
  "resolution_note" = 'The item''s stock changed afterwards (time taken from the next stock alert for this item).'
FROM (
  SELECT a2."id", min(b."created_at") AS "at"
  FROM "alerts" a2
  JOIN "alerts" b ON b."org_id" = a2."org_id" AND b."variant_id" = a2."variant_id" AND b."id" <> a2."id" AND b."created_at" > a2."created_at"
    AND b."type" IN ('restocked', 'low_stock', 'out_of_stock')
  WHERE a2."type" IN ('low_stock', 'out_of_stock') AND a2."resolved_at" IS NULL AND a2."variant_id" IS NOT NULL
  GROUP BY a2."id"
) n
WHERE a."id" = n."id";--> statement-breakpoint
-- Same idea for failed collections: a later failure alert for the website means collection recovered in between.
UPDATE "alerts" a SET "resolved_at" = n."at", "resolution_kind" = 'automatic',
  "resolution_note" = 'Collection of this website recovered afterwards (time taken from the next failure alert).'
FROM (
  SELECT a2."id", min(b."created_at") AS "at"
  FROM "alerts" a2
  JOIN "alerts" b ON b."org_id" = a2."org_id" AND b."site_id" = a2."site_id" AND b."id" <> a2."id" AND b."created_at" > a2."created_at" AND b."type" = 'collection_failure'
  WHERE a2."type" = 'collection_failure' AND a2."resolved_at" IS NULL AND a2."site_id" IS NOT NULL
  GROUP BY a2."id"
) n
WHERE a."id" = n."id";--> statement-breakpoint
-- Whatever is still open: if the item's CURRENT stock state is no longer the alert's condition, or the website is collecting fine again, the
-- condition has cleared. The exact time was not recorded, so resolved_at is the time this migration noticed, and the note says so.
UPDATE "alerts" a SET "resolved_at" = now(), "resolution_kind" = 'automatic',
  "resolution_note" = 'The item is no longer in this stock state. The exact time was not recorded before alert tracking was added.'
FROM "stock_states" s
WHERE a."variant_id" = s."variant_id" AND a."resolved_at" IS NULL
  AND ((a."type" = 'low_stock' AND s."state" <> 'low_stock' AND s."state" <> 'unknown')
    OR (a."type" = 'out_of_stock' AND s."state" <> 'out_of_stock' AND s."state" <> 'unknown'));--> statement-breakpoint
UPDATE "alerts" a SET "resolved_at" = now(), "resolution_kind" = 'automatic',
  "resolution_note" = 'Collection for this website has since succeeded. The exact time was not recorded before alert tracking was added.'
FROM "collection_health" c
WHERE a."site_id" = c."site_id" AND a."type" = 'collection_failure' AND a."resolved_at" IS NULL AND c."failing" = false;
