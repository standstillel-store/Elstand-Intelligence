/**
 * Provider payloads carry URLs (a news link, a source page). They are untrusted: a link is
 * made clickable only if it is an absolute http or https URL without embedded credentials.
 * Anything else, such as `javascript:` or `data:`, is shown as plain text and never linked.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}
