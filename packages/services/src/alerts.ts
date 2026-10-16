import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { RESOLVABLE_ALERT_TYPES, type AlertSeverity, type AlertStatus, type AlertType } from '@ci/shared';
import { alertRules, alerts, auditEvents, evidence, memberships, orgSettings, products, sites, users, variants, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { layout } from './mailer.ts';

export interface NewAlert {
  orgId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  body?: string | null;
  siteId?: string | null;
  variantId?: string | null;
  reportId?: string | null;
  /** The page observation that raised the alert, when there is one. */
  evidenceId?: string | null;
  /** Unique per (org, transition). Re-evaluating the same transition inserts nothing. */
  dedupeKey: string;
  data?: Record<string, unknown>;
}

/**
 * Creates an alert exactly once per dedupe key (database-enforced). Returns the id only when a NEW alert was created,
 * so callers can tell "this is news" from "we already told them".
 */
export async function raiseAlert(db: DbLike, a: NewAlert): Promise<string | null> {
  const [rule] = await db.select().from(alertRules).where(and(eq(alertRules.orgId, a.orgId), eq(alertRules.type, a.type)));
  if (rule && !rule.enabled) return null;
  const [row] = await db
    .insert(alerts)
    .values({ orgId: a.orgId, type: a.type, severity: a.severity, title: a.title.slice(0, 300), body: a.body ?? null, siteId: a.siteId ?? null, variantId: a.variantId ?? null, reportId: a.reportId ?? null, evidenceId: a.evidenceId ?? null, data: a.data ?? {}, dedupeKey: a.dedupeKey })
    .onConflictDoNothing({ target: [alerts.orgId, alerts.dedupeKey] })
    .returning({ id: alerts.id });
  return row?.id ?? null;
}

export async function alertRecipients(db: DbLike, orgId: string): Promise<{ recipients: string[]; prefs: { inApp: boolean; email: boolean; dailySummaryEmail: boolean } }> {
  const [s] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const prefs = s?.alertPrefs ?? { inApp: true, email: true, dailySummaryEmail: true, recipients: [] };
  let recipients = prefs.recipients;
  if (!recipients.length) {
    const owners = await db
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, orgId), inArray(memberships.role, ['owner', 'admin'])));
    recipients = owners.map((o) => o.email);
  }
  return { recipients, prefs };
}

/** One email summarising newly created alerts (never one email per product). */
export async function emailAlertDigest(svc: Services, db: DbLike, orgId: string, alertIds: string[], context: string): Promise<void> {
  if (!alertIds.length) return;
  const rows = await db.select().from(alerts).where(and(eq(alerts.orgId, orgId), inArray(alerts.id, alertIds), isNull(alerts.emailedAt)));
  if (!rows.length) return;
  const { recipients, prefs } = await alertRecipients(db, orgId);
  const rules = await db.select().from(alertRules).where(eq(alertRules.orgId, orgId));
  const emailOff = new Set(rules.filter((r) => !r.channelEmail).map((r) => r.type));
  const toSend = rows.filter((r) => !emailOff.has(r.type));
  if (!prefs.email || !recipients.length || !toSend.length) return;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const list = toSend.slice(0, 40).map((r) => `<li style="margin-bottom:8px"><strong>${esc(r.title)}</strong>${r.body ? `<br><span style="color:#5d574b">${esc(r.body)}</span>` : ''}</li>`).join('');
  const more = toSend.length > 40 ? `<p>…and ${toSend.length - 40} more in the app.</p>` : '';
  const subject = toSend.length === 1 ? `Alert: ${toSend[0]!.title}` : `${toSend.length} new alerts (${context})`;
  await svc.mailer.queue(db, {
    orgId,
    to: recipients,
    subject,
    text: toSend.map((r) => `- ${r.title}${r.body ? `: ${r.body}` : ''}`).join('\n') + `\n\nOpen ${svc.config.APP_BASE_URL}/alerts`,
    html: layout(subject, `<ul style="padding-left:18px">${list}</ul>${more}<p><a href="${esc(svc.config.APP_BASE_URL)}/alerts">Open alerts</a></p>`),
    kind: 'alert-digest',
  });
  await db.update(alerts).set({ emailedAt: svc.clock() }).where(inArray(alerts.id, toSend.map((r) => r.id)));
}

export async function acknowledgeAlert(db: DbLike, orgId: string, alertId: string, userId: string, now: Date): Promise<boolean> {
  const r = await db.update(alerts).set({ acknowledgedAt: now, acknowledgedBy: userId }).where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId))).returning({ id: alerts.id });
  return r.length > 0;
}

// ───────────────────────────────────────────────────────────── lifecycle: open → acknowledged → resolved

export function alertStatusOf(a: { acknowledgedAt: Date | null; resolvedAt: Date | null }): AlertStatus {
  return a.resolvedAt ? 'resolved' : a.acknowledgedAt ? 'acknowledged' : 'open';
}

export const isResolvableAlertType = (t: string) => (RESOLVABLE_ALERT_TYPES as readonly string[]).includes(t);

/**
 * Closes open alerts whose condition has demonstrably cleared (the item is back in stock, the website was collected again, the store
 * connection synced). Never guesses: callers pass the observation that showed the condition had cleared. Returns how many were closed.
 */
export async function resolveClearedAlerts(
  db: DbLike,
  p: { orgId: string; types: AlertType[]; note: string; now: Date; variantId?: string; siteId?: string; connectionId?: string; evidenceId?: string | null },
): Promise<number> {
  const conds = [eq(alerts.orgId, p.orgId), inArray(alerts.type, p.types), isNull(alerts.resolvedAt)];
  if (p.variantId) conds.push(eq(alerts.variantId, p.variantId));
  if (p.siteId) conds.push(eq(alerts.siteId, p.siteId));
  if (p.connectionId) conds.push(sql`${alerts.data}->>'connectionId' = ${p.connectionId}`);
  const r = await db
    .update(alerts)
    .set({ resolvedAt: p.now, resolutionKind: 'automatic', resolvedBy: null, resolutionNote: p.note.slice(0, 500), resolutionEvidenceId: p.evidenceId ?? null })
    .where(and(...conds))
    .returning({ id: alerts.id });
  return r.length;
}

export type ResolveOutcome = 'resolved' | 'not_found' | 'already_resolved' | 'not_resolvable';

/** A person closes an alert (and, by closing it, acknowledges it). One-off notices have nothing to resolve. */
export async function resolveAlert(db: DbLike, orgId: string, alertId: string, userId: string, now: Date, note?: string): Promise<ResolveOutcome> {
  const [a] = await db.select().from(alerts).where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId)));
  if (!a) return 'not_found';
  if (a.resolvedAt) return 'already_resolved';
  if (!isResolvableAlertType(a.type)) return 'not_resolvable';
  await db
    .update(alerts)
    .set({ resolvedAt: now, resolutionKind: 'manual', resolvedBy: userId, resolutionNote: note?.trim() ? note.trim().slice(0, 500) : null, ...(a.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedBy: userId }) })
    .where(eq(alerts.id, alertId));
  await db.insert(auditEvents).values({ orgId, userId, action: 'alert.resolve', target: alertId, meta: { type: a.type, hasNote: !!note?.trim() } });
  return 'resolved';
}

/** Acknowledges everything still needing attention; resolved alerts are left exactly as they are. */
export async function acknowledgeAll(db: DbLike, orgId: string, userId: string, now: Date): Promise<number> {
  const r = await db.update(alerts).set({ acknowledgedAt: now, acknowledgedBy: userId }).where(and(eq(alerts.orgId, orgId), isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt))).returning({ id: alerts.id });
  return r.length;
}

export interface AlertEvidenceView {
  id: string;
  url: string;
  observedAt: string;
  provenance: string;
  method: string | null;
  snippet: string | null;
  snapshotPurged: boolean;
}

export interface AlertView {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  body: string | null;
  status: AlertStatus;
  /** False for one-off notices (restocked, report ready…): acknowledging is all there is to do. */
  resolvable: boolean;
  createdAt: string;
  siteId: string | null;
  siteName: string | null;
  variantId: string | null;
  productId: string | null;
  productTitle: string | null;
  reportId: string | null;
  data: Record<string, unknown>;
  /** What we looked at when the alert was raised; null when the source was an authorised connection rather than a web page. */
  evidence: AlertEvidenceView | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolution: { at: string; kind: 'automatic' | 'manual'; by: string | null; note: string | null; evidence: AlertEvidenceView | null } | null;
}

export async function listAlerts(
  db: DbLike,
  orgId: string,
  f: { status?: AlertStatus | 'all'; type?: AlertType; severity?: AlertSeverity; page: number; pageSize: number },
): Promise<{ rows: AlertView[]; total: number }> {
  const ev = alias(evidence, 'alert_evidence');
  const rev = alias(evidence, 'resolution_evidence');
  const ackUser = alias(users, 'ack_user');
  const resUser = alias(users, 'res_user');
  const conds = [eq(alerts.orgId, orgId)];
  if (f.status === 'open') conds.push(isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt));
  if (f.status === 'acknowledged') conds.push(isNotNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt));
  if (f.status === 'resolved') conds.push(isNotNull(alerts.resolvedAt));
  if (f.type) conds.push(eq(alerts.type, f.type));
  if (f.severity) conds.push(eq(alerts.severity, f.severity));
  const pageSize = Math.min(Math.max(f.pageSize, 1), 200);
  const offset = (Math.max(f.page, 1) - 1) * pageSize;
  const rows = await db
    .select({
      a: alerts,
      siteName: sites.name,
      productId: products.id,
      productTitle: products.title,
      variantTitle: variants.title,
      ev: { id: ev.id, url: ev.url, at: ev.fetchedAt, provenance: ev.provenance, method: ev.extractionMethod, snippet: ev.snippet, purged: ev.snapshotPurgedAt },
      rev: { id: rev.id, url: rev.url, at: rev.fetchedAt, provenance: rev.provenance, method: rev.extractionMethod, snippet: rev.snippet, purged: rev.snapshotPurgedAt },
      ackName: ackUser.displayName,
      resName: resUser.displayName,
    })
    .from(alerts)
    .leftJoin(sites, eq(sites.id, alerts.siteId))
    .leftJoin(variants, eq(variants.id, alerts.variantId))
    .leftJoin(products, eq(products.id, variants.productId))
    .leftJoin(ev, eq(ev.id, alerts.evidenceId))
    .leftJoin(rev, eq(rev.id, alerts.resolutionEvidenceId))
    .leftJoin(ackUser, eq(ackUser.id, alerts.acknowledgedBy))
    .leftJoin(resUser, eq(resUser.id, alerts.resolvedBy))
    .where(and(...conds))
    .orderBy(desc(alerts.createdAt))
    .limit(pageSize)
    .offset(offset);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(alerts).where(and(...conds));
  const view = (e: { id: string | null; url: string | null; at: Date | null; provenance: string | null; method: string | null; snippet: string | null; purged: Date | null } | null): AlertEvidenceView | null =>
    e?.id && e.url && e.at ? { id: e.id, url: e.url, observedAt: e.at.toISOString(), provenance: e.provenance ?? 'public_web', method: e.method, snippet: e.snippet, snapshotPurged: !!e.purged } : null;
  return {
    total: n,
    rows: rows.map((r) => ({
      id: r.a.id,
      type: r.a.type,
      severity: r.a.severity,
      title: r.a.title,
      body: r.a.body,
      status: alertStatusOf(r.a),
      resolvable: isResolvableAlertType(r.a.type),
      createdAt: r.a.createdAt.toISOString(),
      siteId: r.a.siteId,
      siteName: r.siteName,
      variantId: r.a.variantId,
      productId: r.productId,
      productTitle: r.productTitle,
      reportId: r.a.reportId,
      data: r.a.data,
      evidence: view(r.ev),
      acknowledgedAt: r.a.acknowledgedAt?.toISOString() ?? null,
      acknowledgedBy: r.ackName,
      resolution: r.a.resolvedAt
        ? { at: r.a.resolvedAt.toISOString(), kind: r.a.resolutionKind ?? 'automatic', by: r.resName, note: r.a.resolutionNote, evidence: view(r.rev) }
        : null,
    })),
  };
}
