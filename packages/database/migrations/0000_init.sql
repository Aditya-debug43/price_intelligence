CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channel_in_app" boolean DEFAULT true NOT NULL,
	"channel_email" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"site_id" uuid,
	"variant_id" uuid,
	"report_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"emailed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_health" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"failing" boolean DEFAULT false NOT NULL,
	"episode" integer DEFAULT 0 NOT NULL,
	"last_ok_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"scan_run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" text DEFAULT 'product' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_date" date NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"planned_start_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"assemble_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"assembled_at" timestamp with time zone,
	"report_id" uuid,
	"plan" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"to_addresses" text[] NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"related_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"content_type" text,
	"content_hash" text,
	"bytes" integer,
	"snapshot_ref" text,
	"snapshot_purged_at" timestamp with time zone,
	"snippet" text,
	"extraction_method" text,
	"extraction_version" text,
	"is_fixture" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(24, 8) NOT NULL,
	"source" text NOT NULL,
	"is_fixed" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"url" text NOT NULL,
	"content_hash" text NOT NULL,
	"title" text,
	"page_count" integer,
	"status" text NOT NULL,
	"items_found" integer DEFAULT 0 NOT NULL,
	"needs_review" integer DEFAULT 0 NOT NULL,
	"message" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_id" uuid
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"score" numeric(7, 1) NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"facts" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"site_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"shop_domain" text,
	"scopes" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"excerpt" text,
	"url" text,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"classification" text DEFAULT 'unclassified' NOT NULL,
	"confidence" numeric(4, 3) DEFAULT 0.5 NOT NULL,
	"evidence_id" uuid,
	"extraction_method" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state" text NOT NULL,
	"shop" text,
	"site_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conditional" boolean DEFAULT false NOT NULL,
	"code" text,
	"variant_id" uuid,
	"product_title" text,
	"original_price" numeric(14, 4),
	"sale_price" numeric(14, 4),
	"currency" text,
	"claimed_discount_pct" numeric(6, 2),
	"historical_discount_pct" numeric(6, 2),
	"verification" text DEFAULT 'unverified' NOT NULL,
	"verification_reason" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"missed_complete_scans" integer DEFAULT 0 NOT NULL,
	"source_url" text,
	"evidence_id" uuid,
	"extraction_method" text NOT NULL,
	"confidence" numeric(4, 3),
	"needs_review" boolean DEFAULT false NOT NULL,
	"dedupe_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"reporting_currency" text DEFAULT 'USD' NOT NULL,
	"timezone" text DEFAULT 'America/Aruba' NOT NULL,
	"report_ready_time" text DEFAULT '09:00' NOT NULL,
	"schedule_enabled" boolean DEFAULT true NOT NULL,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"snapshot_retention_days" integer DEFAULT 90 NOT NULL,
	"history_retention_days" integer DEFAULT 365 NOT NULL,
	"alert_prefs" jsonb DEFAULT '{"inApp":true,"email":true,"dailySummaryEmail":true,"recipients":[]}'::jsonb NOT NULL,
	"ai_adjudication" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"price" numeric(14, 4),
	"compare_at_price" numeric(14, 4),
	"currency" text,
	"shipping_cost" numeric(14, 4),
	"availability" text DEFAULT 'unknown' NOT NULL,
	"source_url" text NOT NULL,
	"evidence_id" uuid,
	"scan_run_id" uuid,
	"extraction_method" text NOT NULL,
	"extraction_version" text NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_variant_id" uuid NOT NULL,
	"competitor_variant_id" uuid NOT NULL,
	"competitor_site_id" uuid NOT NULL,
	"match_class" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"status" text NOT NULL,
	"method" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"canonical_url" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"brand" text,
	"manufacturer" text,
	"model" text,
	"mpn" text,
	"description" text,
	"category" text,
	"image_url" text,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extraction_method" text NOT NULL,
	"extraction_version" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_scan_run_id" uuid,
	"missed_complete_scans" integer DEFAULT 0 NOT NULL,
	"delisted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"format" text NOT NULL,
	"dataset" text DEFAULT 'all' NOT NULL,
	"storage_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"kind" text NOT NULL,
	"period_date" date NOT NULL,
	"title" text NOT NULL,
	"is_partial" boolean DEFAULT false NOT NULL,
	"contains_fixture" boolean DEFAULT false NOT NULL,
	"ready_before_deadline" boolean,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_at" timestamp with time zone,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"data_hash" text,
	"data" jsonb,
	"summary_text" text,
	"error" text,
	"created_by" uuid,
	"daily_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"daily_run_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"connector" text,
	"connector_version" text,
	"limit_products" integer,
	"request_budget" integer,
	"requests_made" integer DEFAULT 0 NOT NULL,
	"urls_discovered" integer DEFAULT 0 NOT NULL,
	"urls_fetched" integer DEFAULT 0 NOT NULL,
	"products_saved" integer DEFAULT 0 NOT NULL,
	"variants_saved" integer DEFAULT 0 NOT NULL,
	"errors_count" integer DEFAULT 0 NOT NULL,
	"estimated_total" integer,
	"cursor" jsonb,
	"is_complete" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "site_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"platform" text,
	"data" jsonb NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"origin" text NOT NULL,
	"hostname" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL,
	"consent_status" text DEFAULT 'pending' NOT NULL,
	"consent_note" text,
	"consent_at" timestamp with time zone,
	"consent_by" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"platform" text,
	"currency" text,
	"capability_status" text,
	"last_profiled_at" timestamp with time zone,
	"crawl_delay_ms" integer DEFAULT 1500 NOT NULL,
	"max_requests_per_run" integer DEFAULT 2000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"url" text,
	"discovered_from" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"external_id" text,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"availability" text NOT NULL,
	"quantity" integer,
	"quantity_source" text,
	"tracked" boolean DEFAULT true NOT NULL,
	"location_id" text,
	"location_name" text,
	"connection_id" uuid,
	"evidence_id" uuid,
	"scan_run_id" uuid,
	"is_fixture" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_states" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"state" text DEFAULT 'unknown' NOT NULL,
	"last_known_state" text,
	"episode" integer DEFAULT 0 NOT NULL,
	"quantity" integer,
	"quantity_source" text,
	"basis" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_change_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_key" text NOT NULL,
	"sku" text,
	"gtin" text,
	"title" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qty_kind" text,
	"qty_total" numeric(14, 4),
	"qty_label" text,
	"price" numeric(14, 4),
	"compare_at_price" numeric(14, 4),
	"currency" text,
	"shipping_cost" numeric(14, 4),
	"availability" text DEFAULT 'unknown' NOT NULL,
	"quantity" integer,
	"quantity_source" text,
	"observed_at" timestamp with time zone,
	"last_price_change_at" timestamp with time zone,
	"current_price_observation_id" uuid,
	"url" text NOT NULL,
	"low_stock_threshold" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_health" ADD CONSTRAINT "collection_health_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_health" ADD CONSTRAINT "collection_health_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_log" ADD CONSTRAINT "consent_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_log" ADD CONSTRAINT "consent_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_log" ADD CONSTRAINT "consent_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_queue" ADD CONSTRAINT "crawl_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_queue" ADD CONSTRAINT "crawl_queue_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_queue" ADD CONSTRAINT "crawl_queue_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_runs" ADD CONSTRAINT "daily_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flyers" ADD CONSTRAINT "flyers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flyers" ADD CONSTRAINT "flyers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flyers" ADD CONSTRAINT "flyers_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_activities" ADD CONSTRAINT "marketing_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_activities" ADD CONSTRAINT "marketing_activities_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_activities" ADD CONSTRAINT "marketing_activities_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_source_variant_id_variants_id_fk" FOREIGN KEY ("source_variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_competitor_variant_id_variants_id_fk" FOREIGN KEY ("competitor_variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_competitor_site_id_sites_id_fk" FOREIGN KEY ("competitor_site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_daily_run_id_daily_runs_id_fk" FOREIGN KEY ("daily_run_id") REFERENCES "public"."daily_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_profiles" ADD CONSTRAINT "site_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_profiles" ADD CONSTRAINT "site_profiles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_consent_by_users_id_fk" FOREIGN KEY ("consent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_observations" ADD CONSTRAINT "stock_observations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_observations" ADD CONSTRAINT "stock_observations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_observations" ADD CONSTRAINT "stock_observations_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_observations" ADD CONSTRAINT "stock_observations_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_observations" ADD CONSTRAINT "stock_observations_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_states" ADD CONSTRAINT "stock_states_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_states" ADD CONSTRAINT "stock_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_org_type_uq" ON "alert_rules" USING btree ("org_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_uq" ON "alerts" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_org_time_idx" ON "alerts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_org_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_log_org_idx" ON "consent_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_queue_run_url_uq" ON "crawl_queue" USING btree ("scan_run_id","url");--> statement-breakpoint
CREATE INDEX "crawl_queue_pending_idx" ON "crawl_queue" USING btree ("scan_run_id","status","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_runs_org_date_uq" ON "daily_runs" USING btree ("org_id","period_date");--> statement-breakpoint
CREATE INDEX "email_outbox_org_idx" ON "email_outbox" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_tokens_hash_uq" ON "email_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "evidence_site_idx" ON "evidence" USING btree ("site_id","fetched_at");--> statement-breakpoint
CREATE INDEX "evidence_purge_idx" ON "evidence" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "fx_pair_idx" ON "exchange_rates" USING btree ("base","quote","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flyers_site_hash_uq" ON "flyers" USING btree ("site_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_report_key_uq" ON "insights" USING btree ("report_id","key");--> statement-breakpoint
CREATE INDEX "insights_org_score_idx" ON "insights" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_org_idx" ON "integration_connections" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_dedupe_uq" ON "marketing_activities" USING btree ("org_id","site_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "marketing_site_idx" ON "marketing_activities" USING btree ("site_id","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_uq" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_uq" ON "oauth_states" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_dedupe_uq" ON "offers" USING btree ("org_id","site_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "offers_site_status_idx" ON "offers" USING btree ("site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "price_obs_variant_idx" ON "price_observations" USING btree ("variant_id","observed_at");--> statement-breakpoint
CREATE INDEX "price_obs_org_time_idx" ON "price_observations" USING btree ("org_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_pair_uq" ON "product_matches" USING btree ("source_variant_id","competitor_variant_id");--> statement-breakpoint
CREATE INDEX "matches_org_status_idx" ON "product_matches" USING btree ("org_id","status","match_class");--> statement-breakpoint
CREATE INDEX "matches_competitor_idx" ON "product_matches" USING btree ("competitor_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_site_url_uq" ON "products" USING btree ("site_id","canonical_url");--> statement-breakpoint
CREATE INDEX "products_org_site_idx" ON "products" USING btree ("org_id","site_id");--> statement-breakpoint
CREATE INDEX "products_first_seen_idx" ON "products" USING btree ("site_id","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_exports_uq" ON "report_exports" USING btree ("report_id","format","dataset");--> statement-breakpoint
CREATE INDEX "reports_org_period_idx" ON "reports" USING btree ("org_id","period_date","created_at");--> statement-breakpoint
CREATE INDEX "scan_runs_site_idx" ON "scan_runs" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "scan_runs_org_idx" ON "scan_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "site_profiles_site_idx" ON "site_profiles" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_org_host_uq" ON "sites" USING btree ("org_id","hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_one_active_source_uq" ON "sites" USING btree ("org_id") WHERE "sites"."role" = 'source' and "sites"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_uq" ON "social_accounts" USING btree ("site_id","platform","handle");--> statement-breakpoint
CREATE INDEX "stock_obs_variant_idx" ON "stock_observations" USING btree ("variant_id","observed_at");--> statement-breakpoint
CREATE INDEX "stock_obs_org_time_idx" ON "stock_observations" USING btree ("org_id","observed_at");--> statement-breakpoint
CREATE INDEX "stock_states_org_idx" ON "stock_states" USING btree ("org_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "variants_product_key_uq" ON "variants" USING btree ("product_id","variant_key");--> statement-breakpoint
CREATE INDEX "variants_site_idx" ON "variants" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "variants_gtin_idx" ON "variants" USING btree ("org_id","gtin");--> statement-breakpoint
CREATE INDEX "variants_observed_idx" ON "variants" USING btree ("site_id","observed_at");