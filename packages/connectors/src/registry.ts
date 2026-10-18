import type { ConnectorId, SiteProfileData } from '@ci/shared';
import { shopifyConnector } from './shopify.ts';
import { woocommerceConnector } from './woocommerce.ts';
import { browserConnector, htmlGenericConnector, listingConnector, llmFallbackConnector, structuredDataConnector } from './page-crawl.ts';
import type { AnyConnector } from './types.ts';

/** Every connector is registered here. Adding a site-specific connector means adding one file and one line. */
export const CONNECTORS: AnyConnector[] = [
  shopifyConnector,
  woocommerceConnector,
  structuredDataConnector,
  htmlGenericConnector,
  listingConnector,
  browserConnector,
  llmFallbackConnector,
];

export function getConnector(id: string): AnyConnector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

export interface Capabilities {
  browserEnabled: boolean;
  aiEnabled: boolean;
}

export interface RankedConnector {
  id: ConnectorId;
  score: number;
  reason: string;
}

/** Orders connectors by how well they fit the profiled site. Connectors that can't run here are excluded. */
export function rankConnectors(profile: SiteProfileData, caps: Capabilities): RankedConnector[] {
  return CONNECTORS.map((c) => ({ id: c.id, ...c.applicability(profile) }))
    .filter((r) => r.score > 0)
    .filter((r) => (r.id === 'browser-rendered' ? caps.browserEnabled : true))
    .filter((r) => (r.id === 'llm-fallback' ? caps.aiEnabled : true))
    .sort((a, b) => b.score - a.score);
}
