import { z } from 'zod';
import { DECIDABLE_RELATIONSHIPS, MATCH_CLASSES, MATCHING_ENGINES, MEMBER_ROLES, SITE_ROLES } from './constants.ts';

export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const timezone = z.string().refine(isValidTimezone, 'Must be a valid IANA timezone, e.g. America/Aruba');
const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO currency code')
  .transform((s) => s.toUpperCase());
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');

export const registerSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  displayName: z.string().trim().min(1).max(100),
});

export const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

export const forgotPasswordSchema = z.object({ email: z.email().max(254) });
export const resendVerificationSchema = z.object({ email: z.email().max(254) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, 'Use at least 10 characters').max(200) });
export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(10).max(200),
});
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

export const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(100),
});

export const addMemberSchema = z.object({
  email: z.email(),
  role: z.enum(MEMBER_ROLES).default('staff'),
});
export const updateMemberSchema = z.object({ role: z.enum(MEMBER_ROLES) });

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(MEMBER_ROLES).default('staff'),
});
export const invitationTokenSchema = z.object({ token: z.string().trim().min(20).max(200) });

export const addSiteSchema = z.object({
  url: z.string().trim().min(3).max(2048),
  role: z.enum(SITE_ROLES),
  name: z.string().trim().min(1).max(120).optional(),
});

export const updateSiteSchema = z.object({
  url: z.string().trim().min(3).max(2048).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
  crawlDelayMs: z.number().int().min(250).max(60_000).optional(),
  maxRequestsPerRun: z.number().int().min(10).max(100_000).optional(),
});

export const consentSchema = z.object({
  status: z.enum(['confirmed', 'revoked']),
  note: z.string().trim().max(1000).optional(),
  /** The owner explicitly attests that they are entitled to run (or have been authorised to run) this collection. */
  attest: z.boolean().optional(),
  /** The website's terms forbid automated access, and its owner gave written permission (the note says where that is kept). */
  writtenPermission: z.boolean().optional(),
});

export const startScanSchema = z.object({
  kind: z.enum(['discovery', 'refresh', 'sample']).default('discovery'),
  /** For `sample`: cap on products fetched, so a small refresh can be run first. */
  limit: z.number().int().min(1).max(500).optional(),
});

export const settingsSchema = z.object({
  reportingCurrency: currency.optional(),
  timezone: timezone.optional(),
  reportReadyTime: hhmm.optional(),
  scheduleEnabled: z.boolean().optional(),
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  snapshotRetentionDays: z.number().int().min(1).max(3650).optional(),
  historyRetentionDays: z.number().int().min(30).max(3650).optional(),
  alertPrefs: z
    .object({
      inApp: z.boolean(),
      email: z.boolean(),
      dailySummaryEmail: z.boolean(),
      recipients: z.array(z.email()).max(20),
    })
    .optional(),
  enabledAiAdjudication: z.boolean().optional(),
  /** Which matching engine proposes matches: the earlier one, engine v2 in shadow, or engine v2. */
  matchingEngine: z.enum(MATCHING_ENGINES).optional(),
});

export const matchDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject', 'reclassify']),
  matchClass: z.enum(MATCH_CLASSES).optional(),
  /** What the person says these products are (exact / variant / substitute / related). */
  relationship: z.enum(DECIDABLE_RELATIONSHIPS).optional(),
  note: z.string().max(500).optional(),
});

/**
 * Accepting many proposals at once. Names and sizes can agree on hundreds of pairs when the shops publish no barcodes or brands; going through
 * them one by one is not realistic, so a person may accept every waiting proposal of one class at or above a confidence — after seeing how
 * many there are and a sample. `dryRun` only counts and samples.
 */
export const bulkAcceptSchema = z.object({
  matchClass: z.enum(['identical', 'different_pack']),
  minConfidence: z.number().min(0.5).max(1),
  siteId: z.uuid().optional(),
  dryRun: z.boolean().default(false),
  note: z.string().max(300).optional(),
});

/** A person chooses the competitor product that corresponds to one of their own products (instead of, or in addition to, a suggestion). */
export const manualMatchSchema = z.object({
  sourceVariantId: z.uuid(),
  competitorVariantId: z.uuid(),
  matchClass: z.enum(['identical', 'different_pack', 'comparable']).optional(),
  relationship: z.enum(DECIDABLE_RELATIONSHIPS).optional(),
  /** The suggestion being corrected; it is rejected so it is not proposed again. */
  replaceMatchId: z.uuid().optional(),
  note: z.string().max(500).optional(),
});

const optionalMoney = z.number().positive().max(10_000_000).multipleOf(0.01).optional();

/** A person's verdict on an offer the machine read from a flyer or page: keep it, fix what was misread, or say it is not an offer. */
export const offerReviewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal('dismiss'), note: z.string().trim().max(500).optional() }),
  z.object({
    action: z.literal('correct'),
    title: z.string().trim().min(1).max(200).optional(),
    salePrice: optionalMoney,
    originalPrice: optionalMoney,
    currency: z.string().trim().length(3).toUpperCase().optional(),
    validFrom: z.iso.datetime().nullable().optional(),
    validTo: z.iso.datetime().nullable().optional(),
    note: z.string().trim().max(500).optional(),
  }),
]);
export type OfferReviewInput = z.infer<typeof offerReviewSchema>;

export const alertRuleSchema = z.object({
  type: z.enum(['low_stock', 'out_of_stock', 'restocked', 'collection_failure']),
  enabled: z.boolean(),
  channelInApp: z.boolean().default(true),
  channelEmail: z.boolean().default(true),
});

export const variantThresholdSchema = z.object({ threshold: z.number().int().min(0).max(100_000).nullable() });

export const shopifyStartSchema = z.object({
  shop: z.string().trim().min(3).max(255),
  siteId: z.uuid().optional(),
});


export const socialAccountSchema = z.object({
  siteId: z.uuid(),
  platform: z.enum(['facebook', 'instagram', 'youtube']),
  handle: z.string().trim().min(1).max(200),
  url: z.string().url().max(2048).optional(),
});

export const reportGenerateSchema = z.object({}).strict();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
export type AddSiteInput = z.infer<typeof addSiteSchema>;
