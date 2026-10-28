/**
 * Links from Shelfwatch to the page where a product is sold, so a person can check a price at the shop itself.
 *
 * The address comes from the collection record (`variants.url`, the page the product and its price were read from). It is
 * never built, guessed or borrowed from another shop. This helper only decides whether a stored address is safe to put
 * behind a link: an ordinary web address, without a password in it, that points at a page and not at the shop's front door.
 * Anything else is "no link", and the screen says so instead of showing a link that would mislead.
 */

/** Longer than any real product address; anything beyond this is malformed or hostile. */
export const MAX_SOURCE_URL_LENGTH = 2048;

export interface SourceLink {
  /** The address to open (normalised by the URL parser; the same page as the stored address). */
  href: string;
  /** The website the link opens, without a leading "www.", for showing next to the link. */
  host: string;
}

/** The address when it is safe to link to, otherwise `null`. Never throws. */
export function safeSourceUrl(raw: unknown): string | null {
  return sourceLink(raw)?.href ?? null;
}

export function sourceLink(raw: unknown): SourceLink | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > MAX_SOURCE_URL_LENGTH) return null;
  // Spaces and control characters are never part of a stored address; they mean the value was damaged.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 32 || code === 127) return null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  // A product page is never the shop's front door. (`/?p=123` style addresses have a query and are kept.)
  if ((url.pathname === '' || url.pathname === '/') && !url.search) return null;
  return { href: url.href, host: host.replace(/^www\./, '') };
}
