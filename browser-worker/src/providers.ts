import { z } from 'zod';

import { Config, Runtime, Failure } from './platform';

const uid = z.string().regex(/^[a-f0-9]{32}$/);

const videoSchema = z.object({
  uid,
  creator: z.string().optional(),
  readyToStream: z.boolean().optional(),
  duration: z.number().nonnegative().optional(),
  requireSignedURLs: z.boolean(),
  status: z
    .object({
      state: z.string(),
      errorCode: z.string().optional(),
      errorReasonText: z.string().optional(),
    })
    .optional(),
});

export type Video = z.infer<typeof videoSchema>;

export class StreamProvider {
  constructor(
    private c: Config,
    private runtime: Runtime,
  ) {}
  private endpoint(path = '') {
    if (!this.c.CLOUDFLARE_ACCOUNT_ID || !this.c.CLOUDFLARE_API_TOKEN)
      throw new Failure(503, 'STREAM_NOT_CONFIGURED', 'Video hosting is not configured yet.');
    return `https://api.cloudflare.com/client/v4/accounts/${this.c.CLOUDFLARE_ACCOUNT_ID}/stream${path}`;
  }
  private async request(path: string, options: RequestInit = {}) {
    let r: Response;
    try {
      r = await this.runtime.fetch(this.endpoint(path), {
        ...options,
        headers: {
          Authorization: `Bearer ${this.c.CLOUDFLARE_API_TOKEN}`,
          ...Object.fromEntries(new Headers(options.headers)),
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Failure(
        503,
        'STREAM_UNAVAILABLE',
        'The video provider is temporarily unavailable.',
      );
    }
    return r;
  }
  async create(bytes: number, expiry: number, creator: string) {
    const metadata = [
      `maxDurationSeconds ${btoa('600')}`,
      'requiresignedurls',
      `expiry ${btoa(new Date(expiry).toISOString())}`,
      `creator ${btoa(creator)}`,
      `allowedorigins ${btoa(new URL(this.c.PUBLIC_BASE_URL!).hostname)}`,
    ].join(',');
    const r = await this.request('?direct_user=true', {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(bytes),
        'Upload-Metadata': metadata,
      },
    });
    if (!r.ok)
      throw new Failure(
        503,
        'STREAM_CREATE',
        'The video upload could not be provisioned. Retry after the service recovers.',
      );
    const location = r.headers.get('location'),
      mediaId = r.headers.get('stream-media-id');
    if (!location || !mediaId || !uid.safeParse(mediaId).success)
      throw new Failure(
        503,
        'STREAM_CREATE_UNCERTAIN',
        'The video provider returned an incomplete upload association.',
      );
    let u: URL;
    try {
      u = new URL(location);
    } catch {
      throw new Failure(
        503,
        'STREAM_CREATE_UNCERTAIN',
        'The video provider returned an invalid upload address.',
      );
    }
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !(
        u.hostname === 'upload.cloudflarestream.com' ||
        u.hostname.endsWith('.cloudflarestream.com') ||
        u.hostname === 'upload.videodelivery.net' ||
        u.hostname.endsWith('.videodelivery.net')
      )
    )
      throw new Failure(
        503,
        'STREAM_CREATE_UNCERTAIN',
        'The video provider returned an invalid upload address.',
      );
    return { uid: mediaId, url: u.href, expiresAt: new Date(expiry).toISOString() };
  }
  async get(id: string): Promise<Video | null> {
    uid.parse(id);
    const r = await this.request(`/${id}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Failure(503, 'STREAM_STATUS', 'The video status could not be confirmed.');
    const result = z
      .object({ success: z.literal(true), result: videoSchema })
      .safeParse(await r.json());
    if (!result.success || result.data.result.uid !== id)
      throw new Failure(503, 'STREAM_STATUS', 'The video provider returned an invalid status.');
    return result.data.result;
  }
  async remove(id: string) {
    uid.parse(id);
    const r = await this.request(`/${id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404)
      throw new Failure(503, 'STREAM_DELETE', 'The hosted video could not be deleted.');
    if ((await this.get(id)) !== null)
      throw new Failure(
        503,
        'STREAM_DELETE_PENDING',
        'The video provider has not confirmed deletion.',
      );
  }
  async download(id: string) {
    uid.parse(id);
    const r = await this.request(`/${id}/downloads`, { method: 'POST' });
    if (!r.ok) throw new Failure(503, 'STREAM_EXPORT', 'The hosted export could not be prepared.');
    const parsed = z
      .object({
        success: z.literal(true),
        result: z.object({
          default: z.object({ status: z.enum(['ready', 'inprogress', 'queued']) }),
        }),
      })
      .safeParse(await r.json());
    if (!parsed.success)
      throw new Failure(503, 'STREAM_EXPORT', 'The provider returned an invalid export state.');
    return parsed.data.result.default.status === 'ready';
  }
  async findCreated(creator: string) {
    const r = await this.request(`?creator=${encodeURIComponent(creator)}&limit=1000`);
    if (!r.ok)
      throw new Failure(
        503,
        'STREAM_RECONCILIATION',
        'The provider upload associations could not be reconciled.',
      );
    const list = z
      .object({ success: z.literal(true), result: z.array(videoSchema).max(1000) })
      .safeParse(await r.json());
    if (
      !list.success ||
      list.data.result.length >= 1000 ||
      list.data.result.some((v) => v.creator !== creator)
    )
      throw new Failure(
        503,
        'STREAM_RECONCILIATION',
        'The provider returned an invalid association list.',
      );
    return list.data.result;
  }
  async playback(id: string, expires: number, ip: string | null, download = false) {
    uid.parse(id);
    const payload: {
      exp: number;
      downloadable: boolean;
      accessRules?: { type: string; action: string; ip?: string[] }[];
    } = { exp: Math.floor(expires / 1000), downloadable: download };
    if (ip && /^[0-9a-fA-F:.]+$/.test(ip))
      payload.accessRules = [
        { type: 'ip.src', action: 'allow', ip: [ip] },
        { type: 'any', action: 'block' },
      ];
    const r = await this.request(`/${id}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Failure(503, 'STREAM_PLAYBACK', 'Playback is temporarily unavailable.');
    const parsed = z
      .object({
        success: z.literal(true),
        result: z.object({
          token: z
            .string()
            .min(20)
            .max(8192)
            .regex(/^[A-Za-z0-9_.-]+$/),
        }),
      })
      .safeParse(await r.json());
    if (!parsed.success)
      throw new Failure(503, 'STREAM_PLAYBACK', 'The provider returned an invalid playback grant.');
    return `https://customer-${this.c.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${parsed.data.result.token}/${download ? 'downloads/default.mp4' : 'iframe'}`;
  }
}
export class StripeProvider {
  constructor(
    private c: Config,
    private runtime: Runtime,
  ) {}
  async request(
    path: string,
    values?: URLSearchParams,
    idempotency?: string,
  ): Promise<Record<string, unknown>> {
    if (!this.c.STRIPE_SECRET_KEY)
      throw new Failure(503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured yet.');
    let r: Response;
    try {
      r = await this.runtime.fetch(`https://api.stripe.com/v1${path}`, {
        method: values ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.c.STRIPE_SECRET_KEY}`,
          'Stripe-Version': '2024-06-20',
          ...(values ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
        },
        ...(values ? { body: values } : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Failure(503, 'STRIPE_UNAVAILABLE', 'Billing is temporarily unavailable.');
    }
    if (!r.ok) throw new Failure(503, 'STRIPE_UNAVAILABLE', 'Billing is temporarily unavailable.');
    const parsed = z.record(z.string(), z.unknown()).safeParse(await r.json());
    if (!parsed.success)
      throw new Failure(
        503,
        'STRIPE_RESPONSE',
        'The billing provider returned an invalid response.',
      );
    return parsed.data;
  }
  async price() {
    const value = await this.request(`/prices/${this.c.STRIPE_PRICE_ID}`);
    const p = z
      .object({
        id: z.literal(this.c.STRIPE_PRICE_ID!),
        active: z.literal(true),
        currency: z.literal('usd'),
        unit_amount: z.literal(1500),
        livemode: z.boolean(),
        recurring: z.object({
          interval: z.literal('month'),
          interval_count: z.literal(1),
          usage_type: z.literal('licensed').optional(),
        }),
      })
      .safeParse(value);
    if (!p.success || p.data.livemode !== this.c.STRIPE_SECRET_KEY!.startsWith('sk_live_'))
      throw new Failure(
        503,
        'PRICE_CONFIGURATION',
        'The configured price must be the Rushes $15 monthly subscription.',
      );
    return p.data;
  }
  async subscriptions(customer: string) {
    const result: Record<string, unknown>[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const p = new URLSearchParams({
        customer,
        status: 'all',
        limit: '100',
        'expand[]': 'data.latest_invoice',
      });
      if (cursor) p.set('starting_after', cursor);
      const r = await this.request(`/subscriptions?${p}`);
      const parsed = z
        .object({
          data: z.array(z.record(z.string(), z.unknown())).max(100),
          has_more: z.boolean(),
        })
        .safeParse(r);
      if (!parsed.success)
        throw new Failure(
          503,
          'STRIPE_RESPONSE',
          'The current subscriptions could not be verified.',
        );
      result.push(...parsed.data.data);
      if (!parsed.data.has_more) return result;
      cursor = String(parsed.data.data.at(-1)?.id ?? '');
      if (!cursor) break;
    }
    throw new Failure(
      503,
      'STRIPE_RESPONSE',
      'The account subscriptions exceeded the reconciliation limit.',
    );
  }
}
