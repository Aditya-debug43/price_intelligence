import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULTS, addSiteSchema, consentSchema, startScanSchema, updateSiteSchema, paginationSchema } from '@ci/shared';
import { crawlQueue, scanRuns, sites } from '@ci/database';
import { CONSENT_TEXT, CONSENT_TEXT_VERSION, addSite, cancelScan, getSite, loadCoverage, latestProfile, listSites, profileHistory, removeSite, setConsent, startScan, updateSite } from '@ci/services';
import { explainScanRun } from '@ci/core';
import { ActionNotPossibleError } from '@ci/services';
import { HttpError, parse, requireRole } from '../app.ts';

const idParam = z.object({ siteId: z.uuid() });

export async function siteRoutes(app: FastifyInstance) {
  app.get('/sites', async (req) => {
    const { list, coverage } = await req.tx(async (tx) => ({ list: await listSites(tx, req.orgId!), coverage: await loadCoverage(tx, req.orgId!, app.svc.clock(), DEFAULTS.staleAfterHours) }));
    return {
      // Every website carries the same honest collection state the dashboard and reports use.
      sites: list.map((s) => ({ ...s, status: coverage.find((c) => c.siteId === s.id)?.status ?? null })),
      consentText: { version: CONSENT_TEXT_VERSION, ...CONSENT_TEXT },
      limits: { maxCompetitors: DEFAULTS.maxCompetitors, minCompetitors: DEFAULTS.minCompetitors },
    };
  });

  app.post('/sites', async (req, reply) => {
    requireRole(req, 'admin');
    const body = parse(addSiteSchema, req.body);
    const site = await req.tx((tx) => addSite(app.svc, tx, req.orgId!, req.user!.id, body));
    return reply.status(201).send({ site });
  });

  app.get('/sites/:siteId', async (req) => {
    const { siteId } = parse(idParam, req.params);
    return { site: await req.tx((tx) => getSite(tx, req.orgId!, siteId)) };
  });

  app.patch('/sites/:siteId', async (req) => {
    requireRole(req, 'admin');
    const { siteId } = parse(idParam, req.params);
    const body = parse(updateSiteSchema.extend({ currency: z.string().regex(/^[A-Za-z]{3}$/).nullable().optional() }), req.body);
    return { site: await req.tx((tx) => updateSite(app.svc, tx, req.orgId!, req.user!.id, siteId, body)) };
  });

  app.delete('/sites/:siteId', async (req) => {
    requireRole(req, 'admin');
    const { siteId } = parse(idParam, req.params);
    await req.tx((tx) => removeSite(tx, req.orgId!, req.user!.id, siteId));
    return { ok: true };
  });

  // ── capability profile: runs in the worker; the page polls for a newer profile
  app.post('/sites/:siteId/profile', async (req, reply) => {
    requireRole(req, 'admin');
    const { siteId } = parse(idParam, req.params);
    await req.tx((tx) => getSite(tx, req.orgId!, siteId));
    const jobId = await app.svc.queue.enqueue('profile-site', { orgId: req.orgId, siteId }, { singletonKey: `profile:${siteId}` });
    return reply.status(202).send({ queued: true, jobId, requestedAt: app.svc.clock().toISOString() });
  });

  app.get('/sites/:siteId/profile', async (req) => {
    const { siteId } = parse(idParam, req.params);
    const p = await req.tx(async (tx) => {
      await getSite(tx, req.orgId!, siteId);
      return latestProfile(tx, req.orgId!, siteId);
    });
    return { profile: p ? { id: p.id, createdAt: p.createdAt, status: p.status, summary: p.summary, data: p.data } : null };
  });

  app.get('/sites/:siteId/profiles', async (req) => {
    const { siteId } = parse(idParam, req.params);
    return { profiles: await req.tx((tx) => profileHistory(tx, req.orgId!, siteId)) };
  });

  // ── consent / authorisation record (collection never starts without it)
  app.post('/sites/:siteId/consent', async (req) => {
    requireRole(req, 'admin');
    const { siteId } = parse(idParam, req.params);
    const body = parse(consentSchema, req.body);
    return { site: await req.tx((tx) => setConsent(app.svc, tx, req.orgId!, req.user!.id, siteId, body)) };
  });

  // ── collection
  app.post('/sites/:siteId/scans', async (req, reply) => {
    requireRole(req, 'admin');
    const { siteId } = parse(idParam, req.params);
    const body = parse(startScanSchema, req.body ?? {});
    const { run, created } = await req.tx((tx) => startScan(app.svc, tx, req.orgId!, siteId, { kind: body.kind, trigger: 'manual', limit: body.limit }));
    return reply.status(created ? 202 : 200).send({ scan: run, alreadyRunning: !created });
  });

  /** "Small live refresh": a limited sample from every consented site, so a demo never needs a full recrawl. */
  app.post('/refresh', async (req, reply) => {
    requireRole(req, 'admin');
    const body = parse(z.object({ limit: z.number().int().min(1).max(200).default(25) }), req.body ?? {});
    const list = await req.tx((tx) => listSites(tx, req.orgId!));
    const started: unknown[] = [];
    const skipped: { siteId: string; name: string; reason: string }[] = [];
    for (const s of list) {
      if (!s.active) continue;
      if (s.consentStatus !== 'confirmed') {
        skipped.push({ siteId: s.id, name: s.name, reason: 'Consent not recorded' });
        continue;
      }
      const r = await req.tx((tx) => startScan(app.svc, tx, req.orgId!, s.id, { kind: 'sample', trigger: 'manual', limit: body.limit }));
      started.push(r.run);
    }
    if (!started.length) {
      // Nothing was started: say why, instead of a success that did nothing.
      const active = list.filter((s) => s.active).length;
      throw new ActionNotPossibleError(
        active === 0 ? 'There are no websites to refresh yet. Add your website and your competitors first.' : 'Nothing could be started: permission to collect has not been recorded for any website yet.',
        'nothing_to_refresh',
        skipped,
      );
    }
    return reply.status(202).send({ started, skipped });
  });

  app.get('/scans', async (req) => {
    const q = parse(paginationSchema.extend({ siteId: z.uuid().optional() }), req.query);
    const rows = await req.tx((tx) =>
      tx
        .select()
        .from(scanRuns)
        .where(q.siteId ? and(eq(scanRuns.orgId, req.orgId!), eq(scanRuns.siteId, q.siteId)) : eq(scanRuns.orgId, req.orgId!))
        .orderBy(desc(scanRuns.createdAt))
        .limit(Math.min(q.pageSize, 100))
        .offset((q.page - 1) * Math.min(q.pageSize, 100)),
    );
    return { scans: rows };
  });

  app.get('/scans/:scanId', async (req) => {
    const { scanId } = parse(z.object({ scanId: z.uuid() }), req.params);
    const detail = await req.tx(async (tx) => {
      const [run] = await tx.select().from(scanRuns).where(and(eq(scanRuns.id, scanId), eq(scanRuns.orgId, req.orgId!)));
      if (!run) return null;
      const [site] = await tx.select({ name: sites.name }).from(sites).where(eq(sites.id, run.siteId));
      const queue = await tx.select().from(crawlQueue).where(eq(crawlQueue.scanRunId, scanId));
      const counts = queue.reduce<Record<string, number>>((a, q) => ({ ...a, [q.status]: (a[q.status] ?? 0) + 1 }), {});
      const failed = queue.filter((q) => q.status === 'failed');
      // Group failures by their reason so "300 pages failed" becomes "280 × HTTP 404, 20 × no price found".
      const reasons = new Map<string, number>();
      for (const q of failed) reasons.set((q.lastError ?? 'unknown error').slice(0, 140), (reasons.get((q.lastError ?? 'unknown error').slice(0, 140)) ?? 0) + 1);
      return {
        run,
        siteName: site?.name ?? '',
        queue: counts,
        explanation: explainScanRun(run, counts),
        failureReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
        failedUrls: failed.slice(0, 20).map((q) => ({ url: q.url, error: q.lastError })),
        skippedUrls: queue.filter((q) => q.status === 'skipped').slice(0, 20).map((q) => ({ url: q.url, error: q.lastError })),
      };
    });
    if (!detail) throw new HttpError(404, 'not_found', 'Collection run not found.');
    return detail;
  });

  app.post('/scans/:scanId/cancel', async (req) => {
    requireRole(req, 'admin');
    const { scanId } = parse(z.object({ scanId: z.uuid() }), req.params);
    return { cancelled: await req.tx((tx) => cancelScan(app.svc, tx, req.orgId!, scanId)) };
  });
}
