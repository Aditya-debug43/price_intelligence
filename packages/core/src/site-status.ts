import type { CapabilityStatus, ScanStatus, SiteState, SiteStatusView } from '@ci/shared';
import { SITE_STATE_LABELS } from '@ci/shared';

export interface SiteStatusInput {
  active: boolean;
  consentStatus: 'pending' | 'confirmed' | 'revoked';
  /** Null until the website has been profiled. */
  capability: CapabilityStatus | null;
  /** Whether the latest capability profile found a method that can read the catalogue (null = unknown). */
  hasUsableMethod: boolean | null;
  /** Products currently listed (not delisted). */
  productCount: number;
  /** Most recent collection run that is not merely queued or cancelled, if any. */
  lastRun: { status: ScanStatus; isComplete: boolean; kind: string; errorCode?: string | null; error?: string | null } | null;
  /** A collection run is queued or running right now. */
  collecting: boolean;
  collectingProgress?: { saved: number; estimated: number | null } | null;
  newestObservationAt: Date | null;
  now: Date;
  staleAfterHours: number;
}

export type SiteStatus = SiteStatusView;

const make = (state: SiteState, severity: SiteStatus['severity'], detail: string, nextAction: string | null = null): SiteStatus => ({ state, label: SITE_STATE_LABELS[state], detail, severity, nextAction });

/**
 * Derives one honest collection state from the facts we hold. Order matters: a website that is blocked, unsupported or failed is never
 * described as "collected with no results", and old data is never described as current.
 */
export function deriveSiteStatus(i: SiteStatusInput): SiteStatus {
  if (!i.active) return make('inactive', 'info', 'This website is switched off and is not collected.', 'Switch it back on to include it.');
  if (i.collecting) {
    const p = i.collectingProgress;
    const progress = p ? ` ${p.saved} product${p.saved === 1 ? '' : 's'} collected${p.estimated ? ` of about ${p.estimated}` : ' so far'}.` : '';
    return make('collecting', 'info', `Collection is running right now.${progress}`);
  }
  if (i.capability === null) return make('not_profiled', 'info', 'We have not yet checked what can be collected from this website.', 'Check this website');
  if (i.capability === 'blocked') {
    return make('access_denied', 'bad', 'The website does not allow automated collection (robots.txt, a login, or bot protection). Nothing was collected, and we will not work around it.', 'Ask the owner for a product feed, or remove this competitor');
  }
  if (i.consentStatus !== 'confirmed') {
    return make('awaiting_permission', 'warn', i.consentStatus === 'revoked' ? 'Permission to collect was withdrawn, so collection is switched off.' : 'Collection starts only after permission to collect from this website is recorded.', 'Record permission');
  }
  if (i.lastRun?.status === 'blocked') {
    return make('access_denied', 'bad', 'The website refused access during collection. We stopped and will not retry around it.', 'Ask the owner for a product feed, or remove this competitor');
  }
  if (i.capability === 'limited' && i.hasUsableMethod === false && i.productCount === 0) {
    return make('unsupported', 'warn', 'No supported way of reading this website’s products was found. This is a limitation of the website, not an empty catalogue.', 'Ask the owner for a product feed, or an authorised platform connection');
  }
  if (i.productCount === 0) {
    if (!i.lastRun) {
      return i.capability === 'failed'
        ? make('failed', 'warn', 'The website could not be checked because of a technical problem. This is not an empty catalogue.', 'Check this website again')
        : make('not_collected', 'info', 'Nothing has been collected from this website yet.', 'Start collection');
    }
    if (i.lastRun.status === 'cancelled') return make('not_collected', 'info', 'The last collection was cancelled before any product was saved.', 'Start collection');
    return make('failed', 'bad', `The last collection did not save any product${i.lastRun.error ? `: ${i.lastRun.error}` : ''}. This is a failure, not an empty catalogue.`, 'Check this website again');
  }
  const ageMs = i.newestObservationAt ? i.now.getTime() - i.newestObservationAt.getTime() : Infinity;
  if (ageMs > i.staleAfterHours * 3_600_000) {
    return make('stale', 'warn', `The newest price on file is older than ${i.staleAfterHours} hours, so it is shown with its original observation time and not as current.`, 'Collect again');
  }
  if (!i.lastRun || i.lastRun.status === 'partial' || i.lastRun.status === 'failed' || (!i.lastRun.isComplete && i.lastRun.kind !== 'refresh')) {
    return make('partial', 'warn', 'Only part of the catalogue has been collected so far. Comparisons use what is available and say so.', 'Collect again');
  }
  return make('collected', 'ok', 'The accessible catalogue was collected and the prices are current.');
}
