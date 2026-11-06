const escapeAttribute = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Builds the iframe snippet for a self-hosted Worker share link (`<base>/s/<id>`).
 * Returns null for anything else, so bucket links never get an embed that cannot work.
 */
export function embedSnippet(link: string, title = 'Rushes recording'): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const match = /^(.*)\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
  if (!match || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  const src = `${url.origin}${match[1]}/embed/${match[2]}`;
  return `<iframe src="${escapeAttribute(src)}" width="640" height="360" title="${escapeAttribute(title)}" frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}
