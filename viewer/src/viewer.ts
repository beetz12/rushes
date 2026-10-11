export {};
interface Manifest {
    id: string;
    status: 'processing' | 'ready' | 'failed';
    title: string;
    summary?: string | null;
    durationMs: number;
    video?: {
        file: string;
    };
    poster?: string;
    captions?: Array<{
        file: string;
        lang: string;
    }>;
    transcript?: string | null;
    chapters?: Array<{
        startMs: number;
        title: string;
    }>;
}
interface Cue {
    startMs: number;
    endMs: number;
    text: string;
}
interface Comment {
    name: string;
    body: string;
    timestampMs: number;
    createdAt: string;
}
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const main = document.querySelector('main')!;
const manifestURL = new URL(main.dataset.manifest!, location.href);
const base = new URL('./', manifestURL);
const share = main.dataset.share!;
const worker = main.dataset.worker === 'true';
const video = element<HTMLVideoElement>('video');
const status = element('status');
const session = crypto.randomUUID().replace(/-/g, '');
const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const asset = (file: string): string => { if (!/^(video-[a-f0-9]{8}\.mp4|poster-[a-f0-9]{8}\.(jpg|png)|captions-[a-f0-9]{8}\.vtt|transcript-[a-f0-9]{8}\.json)$/.test(file))
    throw new Error('Invalid asset'); return new URL(file, base).href; };
const api = (route: string) => new URL(`/api/shares/${share}/${route}`, location.origin).href;
async function post(route: string, data: unknown): Promise<unknown> { const response = await fetch(api(route), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'same-origin' }); if (!response.ok) {
    const b = await response.json() as {
        error?: {
            message?: string;
        };
    };
    throw new Error(b.error?.message ?? 'Request failed');
} return response.json(); }
let initialized = false;
let transcriptVersion = '';
let cues: Cue[] = [];
let cueButtons: HTMLButtonElement[] = [];
let pollCount = 0;
let currentManifest: Manifest | undefined;
let viewSent = false;
function seek(ms: number): void { video.currentTime = Math.max(0, Math.min(video.duration || Infinity, ms / 1000)); }
function line(parent: HTMLElement, text: string, startMs: number): HTMLButtonElement { const button = document.createElement('button'); button.type = 'button'; button.textContent = `${time(startMs)}  ${text}`; button.addEventListener('click', () => seek(startMs)); parent.append(button); return button; }
function safeCues(data: unknown): Cue[] { const list = Array.isArray(data) ? data : (data as {
    cues?: unknown;
    segments?: unknown;
})?.cues ?? (data as {
    segments?: unknown;
})?.segments; if (!Array.isArray(list))
    return []; return list.slice(0, 50000).flatMap((c: Record<string, unknown>) => { const startMs = Number(c.startMs ?? (Number(c.start) * 1000)); const endMs = Number(c.endMs ?? (Number(c.end) * 1000)); return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs >= startMs && typeof c.text === 'string' ? [{ startMs, endMs, text: c.text.slice(0, 5000) }] : []; }); }
async function render(m: Manifest): Promise<void> {
    currentManifest = m;
    element('summary').textContent = m.summary ?? '';
    document.querySelector('h1')!.textContent = m.title;
    document.title = `${m.title} · Rushes`;
    if (m.status === 'failed') {
        status.textContent = 'This video could not be published. Contact the sender.';
        return;
    }
    if (m.status !== 'ready' || !m.video) {
        status.textContent = 'Processing, this page refreshes itself';
        return;
    }
    status.hidden = true;
    video.hidden = false;
    element('tools').hidden = false;
    const src = asset(m.video.file);
    if (video.src !== src) {
        const previous = video.currentTime;
        video.src = src;
        if (initialized)
            video.addEventListener('loadedmetadata', () => seek(previous * 1000), { once: true });
    }
    if (m.poster)
        video.poster = asset(m.poster);
    if (!initialized) {
        initialized = true;
        const t = Number(new URL(location.href).searchParams.get('t'));
        if (Number.isFinite(t) && t > 0)
            video.addEventListener('loadedmetadata', () => seek(t * 1000), { once: true });
    }
    const download = element<HTMLAnchorElement>('download');
    download.href = src;
    download.download = m.title + '.mp4';
    const desired = (m.captions ?? []).map(c => asset(c.file));
    const existing = [...video.querySelectorAll('track')].map(t => t.src);
    if (desired.join() !== existing.join()) {
        for (const track of video.querySelectorAll('track'))
            track.remove();
        for (const caption of m.captions ?? []) {
            const track = document.createElement('track');
            track.kind = 'captions';
            track.srclang = caption.lang;
            track.label = caption.lang;
            track.src = asset(caption.file);
            video.append(track);
        }
    }
    const chapters = element('chapters');
    chapters.replaceChildren();
    for (const chapter of m.chapters ?? [])
        if (Number.isFinite(chapter.startMs) && typeof chapter.title === 'string')
            line(chapters, chapter.title, chapter.startMs);
    if (m.transcript && m.transcript !== transcriptVersion) {
        const r = await fetch(asset(m.transcript), { cache: 'no-store' });
        if (r.ok) {
            const nextCues = safeCues(await r.json());
            if (currentManifest !== m)
                return;
            cues = nextCues;
            transcriptVersion = m.transcript;
            const panel = element('transcript');
            panel.replaceChildren();
            cueButtons = cues.map(c => line(panel, c.text, c.startMs));
        }
    }
    else if (!m.transcript) {
        transcriptVersion = '';
        cues = [];
        cueButtons = [];
        element('transcript').textContent = 'A transcript will appear here when available.';
    }
    if (worker) {
        element('feedback').hidden = false;
        await feedback();
    }
}
async function refresh(): Promise<void> { try {
    const response = await fetch(manifestURL, { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) {
        status.textContent = 'Enter the password to watch this recording.';
        element('unlock').hidden = false;
        return;
    }
    if (response.status === 404) {
        status.textContent = 'This recording is unavailable or has expired.';
        return;
    }
    if (!response.ok)
        throw new Error('Connection failed');
    element('unlock').hidden = true;
    const m = await response.json() as Manifest;
    await render(m);
    pollCount++;
    if (m.status === 'processing' && pollCount < 200)
        setTimeout(refresh, 3000);
    else if (m.status === 'ready' && pollCount < 200)
        setTimeout(refresh, 15000);
    else if (m.status === 'processing')
        status.textContent = 'Still processing. Reload to check again.';
}
catch {
    status.hidden = false;
    status.textContent = 'Cannot load this recording. Reload to try again.';
} }
async function feedback(): Promise<void> { try {
    const r = await fetch(api('feedback'), { cache: 'no-store' });
    if (!r.ok)
        return;
    const data = await r.json() as {
        comments: Comment[];
        reactions: Array<{
            kind: string;
            count: number;
        }>;
    };
    const comments = element('comments'), markers = element('markers');
    comments.replaceChildren();
    markers.replaceChildren();
    for (const comment of data.comments) {
        const article = document.createElement('article');
        const heading = document.createElement('strong');
        heading.textContent = comment.name;
        article.append(heading);
        line(article, comment.body, comment.timestampMs);
        comments.append(article);
        line(markers, comment.name, comment.timestampMs);
    }
    for (const button of element('reactions').querySelectorAll<HTMLButtonElement>('button')) {
        const icons: {
            [key: string]: string;
        } = { like: '👍', love: '❤️', celebrate: '🎉' };
        const kind = button.dataset.reaction!;
        button.textContent = `${icons[kind]} ${data.reactions.find(r => r.kind === kind)?.count ?? 0}`;
    }
}
catch { /* Keep playback usable while feedback is unavailable. */ } }
video.addEventListener('timeupdate', () => { const ms = video.currentTime * 1000; cueButtons.forEach((b, i) => b.classList.toggle('active', ms >= cues[i]!.startMs && ms < cues[i]!.endMs)); });
video.addEventListener('play', async () => { if (worker && !viewSent) {
    try {
        await post('play', { session });
        viewSent = true;
    }
    catch { /* Views do not block playback. */ }
} });
element<HTMLSelectElement>('speed').addEventListener('change', e => { video.playbackRate = Number((e.target as HTMLSelectElement).value); });
element('copy-time').addEventListener('click', async () => { const u = new URL(location.href); u.searchParams.set('t', String(Math.floor(video.currentTime))); try {
    await navigator.clipboard.writeText(u.href);
    element('copy-time').textContent = 'Copied';
    setTimeout(() => element('copy-time').textContent = 'Copy link at this time', 2500);
}
catch {
    status.hidden = false;
    status.textContent = 'Copy this timed link: ' + u.href;
} });
element<HTMLFormElement>('unlock').addEventListener('submit', async (e) => { e.preventDefault(); try {
    await post('unlock', { password: element<HTMLInputElement>('password').value });
    element<HTMLInputElement>('password').value = '';
    await refresh();
}
catch (err) {
    status.textContent = (err as Error).message;
} });
element<HTMLFormElement>('comment-form').addEventListener('submit', async (e) => { e.preventDefault(); try {
    await post('comments', { name: element<HTMLInputElement>('name').value, body: element<HTMLTextAreaElement>('comment').value, timestampMs: Math.floor(video.currentTime * 1000) });
    element<HTMLTextAreaElement>('comment').value = '';
    await feedback();
}
catch (err) {
    status.hidden = false;
    status.textContent = (err as Error).message;
} });
for (const button of element('reactions').querySelectorAll<HTMLButtonElement>('button'))
    button.addEventListener('click', async () => { try {
        await post('reactions', { session, kind: button.dataset.reaction });
        await feedback();
    }
    catch (err) {
        status.hidden = false;
        status.textContent = (err as Error).message;
    } });
void refresh();
