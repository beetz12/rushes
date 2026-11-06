import { describe, expect, it } from 'vitest';
import { embedSnippet } from './embed-snippet';

const ID = 'abcdefghijklmnopqrstuv';

describe('embed code for Worker shares', () => {
  it('points an iframe at the frameable embed route of the same Worker', () => {
    const snippet = embedSnippet(`https://share.example/s/${ID}`, 'Demo');
    expect(snippet).toBe(
      `<iframe src="https://share.example/embed/${ID}" width="640" height="360" title="Demo" frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`,
    );
  });

  it('keeps a base path, drops query and fragment, and escapes the title', () => {
    const snippet = embedSnippet(`https://example.com/rushes/s/${ID}?t=12#x`, '"><script>x</script>');
    expect(snippet).toContain(`src="https://example.com/rushes/embed/${ID}"`);
    expect(snippet).not.toContain('<script>');
    expect(snippet).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('returns null for links that are not Worker share pages', () => {
    expect(embedSnippet('not a url')).toBeNull();
    expect(embedSnippet('https://bucket.example/recordings/index.html')).toBeNull();
    expect(embedSnippet(`javascript:alert(1)//s/${ID}`)).toBeNull();
    expect(embedSnippet(`https://share.example/s/short`)).toBeNull();
  });
});
