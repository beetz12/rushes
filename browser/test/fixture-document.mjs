// Synthetic fixtures stay blank and never request the application or an implicit icon.
const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
export function fixtureDocument(title) {
  const text = title.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
  return `<!doctype html><title>${text}</title><link rel="icon" href="${icon}">`;
}
