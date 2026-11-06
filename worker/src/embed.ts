import { escapeHTML } from '../../cloud/src/page.js';
import type { ShareManifest } from '../../cloud/src/types.js';

/** Headers for the only document other sites may frame. No script runs on the page. */
export const EMBED_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *";
const STYLE = '<style>html,body{margin:0;height:100%;background:#000;color:#fff;font:15px system-ui,sans-serif}video{width:100%;height:100%;display:block;object-fit:contain}.note{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:16px;box-sizing:border-box}a{color:#fff}</style>';

function shell(title: string, body: string, lang = 'en'): string {
    const head = [`<meta charset="utf-8">`, `<title>${escapeHTML(title)} · Rushes</title>`, '<meta name="robots" content="noindex">', STYLE, '<meta name="viewport" content="initial-scale=1,width=device-width">'];
    return `<!doctype html><html lang="${escapeHTML(lang)}"><head>${head.join('')}</head><body>${body}</body></html>`;
}

/** Minimal player for third-party frames: video and captions only, no comments or unlock form. */
export function embedPage(manifest: ShareManifest, base: string, isProtected: boolean): string {
    const page = `${base}/s/${manifest.id}`;
    const open = `<a href="${escapeHTML(page)}" target="_blank" rel="noopener">`;
    if (isProtected)
        return shell('Protected recording', `<div class="note"><p>This recording needs a password.</p><p>${open}Open on Rushes to enter the password</a></p></div>`);
    if (manifest.status !== 'ready' || !manifest.video)
        return shell(manifest.title, `<div class="note"><p>${manifest.status === 'failed' ? 'This recording could not be processed.' : 'This recording is still processing.'}</p><p>${open}Open on Rushes</a></p></div>`);
    const asset = (file: string) => escapeHTML(`${page}/${file}`);
    const poster = manifest.poster ? ` poster="${asset(manifest.poster)}"` : '';
    const tracks = (manifest.captions ?? []).map((c, i) => `<track kind="captions" src="${asset(c.file)}" srclang="${escapeHTML(c.lang.replace('_', '-'))}" label="${escapeHTML(c.lang)}"${i === 0 ? ' default' : ''}>`).join('');
    const lang = (manifest.captions?.[0]?.lang ?? 'en').replace('_', '-');
    return shell(manifest.title, `<video controls playsinline preload="metadata" title="${escapeHTML(manifest.title)}"${poster}><source src="${asset(manifest.video.file)}" type="video/mp4">${tracks}</video>`, lang);
}

export function unavailableEmbed(): string {
    return shell('Unavailable', '<div class="note"><p>This recording is not available.</p></div>');
}

/** Fits the recording's aspect ratio inside the consumer's optional maxwidth/maxheight. */
export function embedSize(manifest: ShareManifest, maxWidth?: number, maxHeight?: number): { width: number; height: number } {
    const w = manifest.video?.width || 1280, h = manifest.video?.height || 720;
    let scale = Math.min(1, 960 / w);
    if (maxWidth) scale = Math.min(scale, maxWidth / w);
    if (maxHeight) scale = Math.min(scale, maxHeight / h);
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function iframeSnippet(src: string, title: string, width: number, height: number): string {
    return `<iframe src="${escapeHTML(src)}" width="${width}" height="${height}" title="${escapeHTML(title)}" frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}
