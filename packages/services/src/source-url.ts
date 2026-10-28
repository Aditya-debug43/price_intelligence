import { sameSiteHost } from '@ci/connectors';
import { safeSourceUrl } from '@ci/shared';

/**
 * The address of a product page that may be shown as a link: a safe web address (see `safeSourceUrl`) that really is on the
 * website the product belongs to. A stored address that is damaged, a front page, or on some other website gives `null`, so a
 * product can never be linked to another shop's page and the screen shows "no link" instead of a misleading one.
 */
export function productPageLink(raw: string | null | undefined, siteHostname: string | null | undefined): string | null {
  const url = safeSourceUrl(raw);
  if (!url || !siteHostname) return null;
  return sameSiteHost(new URL(url).hostname.toLowerCase(), siteHostname.toLowerCase()) ? url : null;
}
