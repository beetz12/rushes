import { z } from 'zod';

import {
  Config,
  Env,
  Runtime,
  Failure,
  needDB,
  response,
  billingReady,
  limited,
  bodyBytes,
  iso,
} from './platform';

import { Auth } from './auth';

import { StripeProvider } from './providers';

import { digest, hmac, equal } from './crypto';

import { tenant } from './records';

const customerId = z.string().regex(/^cus_[A-Za-z0-9]+$/);

const sub = z.object({
  id: z.string(),
  customer: z.union([z.string(), z.object({ id: z.string() })]),
  status: z.string(),
  current_period_start: z.number().int().optional(),
  current_period_end: z.number().int().optional(),
  canceled_at: z.number().int().nullable().optional(),
  ended_at: z.number().int().nullable().optional(),
  items: z.object({
    data: z.array(
      z.object({
        price: z.object({ id: z.string() }),
        quantity: z.number().int().optional(),
        current_period_start: z.number().int().optional(),
        current_period_end: z.number().int().optional(),
      }),
    ),
  }),
  latest_invoice: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .nullable()
    .optional(),
});

function providerId(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string')
    return value.id;
  return null;
}
export async function checkout(c: Config, env: Env, auth: Auth, runtime: Runtime) {
  if (!billingReady(c))
    throw new Failure(503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured yet.');
  const db = needDB(env),
    t = await tenant(env, auth.user.tenantId);
  if (t.status === 'active' && (t.paid_through ?? 0) > runtime.now())
    throw new Failure(
      409,
      'ALREADY_SUBSCRIBED',
      'Manage the existing subscription in billing settings.',
    );
  if (t.status === 'suspended')
    throw new Failure(403, 'ACCOUNT_SUSPENDED', 'This account cannot start a subscription.');
  await limited(db, `checkout:${t.id}`, runtime.now(), 5, 3600000);
  const provider = new StripeProvider(c, runtime);
  await provider.price();
  let customer = t.stripe_customer;
  if (!customer) {
    const created = await provider.request(
      '/customers',
      new URLSearchParams({
        email: auth.user.email,
        name: auth.user.name,
        'metadata[rushes_tenant]': t.id,
      }),
      `rushes-customer-${t.id}`,
    );
    customer = customerId.parse(created.id);
    await db
      .prepare('UPDATE tenants SET stripe_customer=? WHERE id=? AND stripe_customer IS NULL')
      .bind(customer, t.id)
      .run();
    const saved = await tenant(env, t.id);
    if (saved.stripe_customer !== customer)
      throw new Failure(
        503,
        'CUSTOMER_MAPPING',
        'The billing account association could not be confirmed.',
      );
  }
  const value = await provider.request(
    '/checkout/sessions',
    new URLSearchParams({
      mode: 'subscription',
      customer,
      'line_items[0][price]': c.STRIPE_PRICE_ID!,
      'line_items[0][quantity]': '1',
      success_url: `${c.PUBLIC_BASE_URL}/?billing=return`,
      cancel_url: `${c.PUBLIC_BASE_URL}/?billing=canceled`,
      client_reference_id: t.id,
      'subscription_data[metadata][rushes_tenant]': t.id,
      allow_promotion_codes: 'false',
    }),
    `rushes-checkout-${t.id}-${Math.floor(runtime.now() / 300000)}`,
  );
  const url = z.url().parse(value.url);
  if (new URL(url).origin !== 'https://checkout.stripe.com')
    throw new Failure(
      503,
      'CHECKOUT_URL',
      'The billing provider returned an invalid checkout address.',
    );
  return response({ url });
}
export async function portal(c: Config, env: Env, auth: Auth, runtime: Runtime) {
  if (!billingReady(c))
    throw new Failure(503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured yet.');
  const t = await tenant(env, auth.user.tenantId);
  if (!t.stripe_customer)
    throw new Failure(
      409,
      'NO_BILLING_ACCOUNT',
      'Start a subscription before opening billing settings.',
    );
  await limited(needDB(env), `portal:${t.id}`, runtime.now(), 10, 3600000);
  const value = await new StripeProvider(c, runtime).request(
    '/billing_portal/sessions',
    new URLSearchParams({ customer: t.stripe_customer, return_url: `${c.PUBLIC_BASE_URL}/` }),
  );
  const url = z.url().parse(value.url);
  if (new URL(url).origin !== 'https://billing.stripe.com')
    throw new Failure(
      503,
      'PORTAL_URL',
      'The billing provider returned an invalid account address.',
    );
  return response({ url });
}
async function unsafeCharge(provider: StripeProvider, invoice: Record<string, unknown>) {
  const id = providerId(invoice.charge);
  if (!id) return false;
  const charge = await provider.request(`/charges/${encodeURIComponent(id)}`);
  return (
    charge.refunded === true ||
    charge.disputed === true ||
    (typeof charge.amount_refunded === 'number' && charge.amount_refunded > 0)
  );
}
export async function reconcile(c: Config, env: Env, tenantId: string, runtime: Runtime) {
  const db = needDB(env),
    t = await tenant(env, tenantId);
  if (!t.stripe_customer) return;
  const lock = crypto.randomUUID();
  const claimed = await db
    .prepare(
      'UPDATE tenants SET billing_lock=?,billing_lock_until=? WHERE id=? AND (billing_lock IS NULL OR billing_lock_until<=?)',
    )
    .bind(lock, runtime.now() + 60000, t.id, runtime.now())
    .run();
  if (!claimed.meta.changes)
    throw new Failure(503, 'BILLING_BUSY', 'A billing reconciliation is already in progress.');
  try {
    const provider = new StripeProvider(c, runtime);
    await provider.price();
    const subscriptions = await provider.subscriptions(t.stripe_customer);
    let active: { paid: number; start: number; end: number } | null = null,
      late = false,
      canceledAt = 0,
      suspended = false;
    const risks = (
      await db
        .prepare('SELECT charge_id FROM billing_risks WHERE tenant_id=?')
        .bind(t.id)
        .all<{ charge_id: string }>()
    ).results;
    for (const risk of risks) {
      const charge = await provider.request(`/charges/${encodeURIComponent(risk.charge_id)}`);
      if (providerId(charge.customer) !== t.stripe_customer)
        throw new Failure(
          503,
          'CUSTOMER_MAPPING',
          'The provider charge belongs to a different billing account.',
        );
      if (
        charge.refunded === true ||
        charge.disputed === true ||
        (typeof charge.amount_refunded === 'number' && charge.amount_refunded > 0)
      )
        suspended = true;
    }
    for (const value of subscriptions) {
      const parsed = sub.safeParse(value);
      if (!parsed.success)
        throw new Failure(
          503,
          'STRIPE_RESPONSE',
          'The current subscription shape could not be verified.',
        );
      const s = parsed.data;
      if (providerId(s.customer) !== t.stripe_customer)
        throw new Failure(
          503,
          'CUSTOMER_MAPPING',
          'The provider subscription belongs to a different billing account.',
        );
      const item = s.items.data.find((i) => i.price.id === c.STRIPE_PRICE_ID && i.quantity === 1);
      if (!item) continue;
      const start = (s.current_period_start ?? item.current_period_start ?? 0) * 1000,
        end = (s.current_period_end ?? item.current_period_end ?? 0) * 1000;
      let invoice: Record<string, unknown> | null = null;
      if (typeof s.latest_invoice === 'string')
        invoice = await provider.request(`/invoices/${encodeURIComponent(s.latest_invoice)}`);
      else if (s.latest_invoice) invoice = s.latest_invoice;
      if (invoice && (await unsafeCharge(provider, invoice))) suspended = true;
      const paid =
        invoice?.status === 'paid' &&
        typeof invoice.amount_paid === 'number' &&
        invoice.amount_paid >= 1500 &&
        invoice.currency === 'usd' &&
        providerId(invoice.customer) === t.stripe_customer;
      if (s.status === 'active' && paid && end > runtime.now() && start < end) {
        if (!active || end > active.end) active = { paid: end, start, end };
      }
      if (['past_due', 'unpaid', 'incomplete'].includes(s.status)) late = true;
      if (['canceled', 'incomplete_expired'].includes(s.status))
        canceledAt = Math.max(canceledAt, (s.ended_at ?? s.canceled_at ?? 0) * 1000);
    }
    let status = 'none',
      paidThrough = t.paid_through,
      grace: number | null = null,
      periodStart = t.period_start,
      periodEnd = t.period_end;
    if (suspended || t.suspended_by_operator) {
      status = 'suspended';
    } else if (active) {
      status = 'active';
      paidThrough = active.paid;
      periodStart = active.start;
      periodEnd = active.end;
    } else if (late) {
      status = 'past_due';
      grace = (t.paid_through ?? 0) + 7 * 86400000;
    } else if (canceledAt || t.paid_through) {
      status = 'canceled';
      grace = (canceledAt || t.paid_through || runtime.now()) + 30 * 86400000;
    }
    const saved = await db
      .prepare(
        'UPDATE tenants SET status=?,paid_through=?,grace_through=?,period_start=?,period_end=?,updated_at=? WHERE id=? AND billing_lock=?',
      )
      .bind(status, paidThrough, grace, periodStart, periodEnd, runtime.now(), t.id, lock)
      .run();
    if (!saved.meta.changes)
      throw new Failure(
        503,
        'BILLING_LEASE_LOST',
        'Billing reconciliation will retry after a concurrent update.',
      );
  } finally {
    await db
      .prepare(
        'UPDATE tenants SET billing_lock=NULL,billing_lock_until=NULL WHERE id=? AND billing_lock=?',
      )
      .bind(t.id, lock)
      .run();
  }
}
const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.string().max(200),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

export async function webhook(request: Request, c: Config, env: Env, runtime: Runtime) {
  if (!billingReady(c))
    throw new Failure(503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured yet.');
  const bytes = await bodyBytes(request, 1024 * 1024),
    raw = new TextDecoder().decode(bytes),
    header = request.headers.get('stripe-signature') ?? '';
  const items = header.split(',').map((p) => p.split('='));
  const timestamps = items.filter((v) => v[0] === 't');
  const sigs = items.filter((v) => v[0] === 'v1').map((v) => v[1]);
  const timestamp = timestamps.length === 1 ? timestamps[0][1] : '';
  if (!/^\d{10}$/.test(timestamp) || Math.abs(runtime.now() / 1000 - Number(timestamp)) > 300)
    throw new Failure(400, 'WEBHOOK_SIGNATURE', 'The webhook signature is invalid.');
  const computed = [...(await hmac(c.STRIPE_WEBHOOK_SECRET!, `${timestamp}.${raw}`))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  if (!sigs.some((s) => /^[a-f0-9]{64}$/.test(s) && equal(s, computed)))
    throw new Failure(400, 'WEBHOOK_SIGNATURE', 'The webhook signature is invalid.');
  let event: z.infer<typeof eventSchema>;
  try {
    event = eventSchema.parse(JSON.parse(raw));
  } catch {
    throw new Failure(400, 'WEBHOOK_BODY', 'The webhook body is invalid.');
  }
  if (event.livemode !== c.STRIPE_SECRET_KEY!.startsWith('sk_live_'))
    throw new Failure(400, 'WEBHOOK_MODE', 'The webhook mode does not match this service.');
  const db = needDB(env);
  await db
    .prepare(
      "INSERT INTO webhook_events(id,event_type,status,received_at) VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING",
    )
    .bind(event.id, event.type, runtime.now())
    .run();
  const row = await db
    .prepare('SELECT status FROM webhook_events WHERE id=?')
    .bind(event.id)
    .first<{ status: string }>();
  if (row?.status === 'done') return response({ received: true });
  const claim = crypto.randomUUID();
  const lock = await db
    .prepare(
      "UPDATE webhook_events SET status='processing',claim=?,lease_until=?,attempts=attempts+1 WHERE id=? AND (status='pending' OR (status='processing' AND lease_until<=?))",
    )
    .bind(claim, runtime.now() + 120000, event.id, runtime.now())
    .run();
  if (!lock.meta.changes)
    throw new Failure(503, 'WEBHOOK_BUSY', 'This event is still being processed. Retry later.');
  try {
    let customer = providerId(event.data.object.customer);
    if (!customer && event.type.startsWith('customer.') && event.data.object.object === 'customer')
      customer = providerId(event.data.object);
    const provider = new StripeProvider(c, runtime);
    if (!customer && event.type.startsWith('charge.dispute.')) {
      const charge = providerId(event.data.object.charge);
      if (charge)
        customer = providerId(
          (await provider.request(`/charges/${encodeURIComponent(charge)}`)).customer,
        );
    }
    if (customer) {
      const t = await db
        .prepare('SELECT id FROM tenants WHERE stripe_customer=?')
        .bind(customer)
        .first<{ id: string }>();
      if (t) {
        if (event.type.startsWith('charge.')) {
          const chargeId = event.type.startsWith('charge.dispute.')
            ? providerId(event.data.object.charge)
            : providerId(event.data.object);
          if (chargeId)
            await db
              .prepare(
                'INSERT INTO billing_risks(tenant_id,charge_id) VALUES(?,?) ON CONFLICT DO NOTHING',
              )
              .bind(t.id, chargeId)
              .run();
        }
        await reconcile(c, env, t.id, runtime);
      }
    }
    await db
      .prepare(
        "UPDATE webhook_events SET status='done',completed_at=?,claim=NULL,lease_until=NULL WHERE id=? AND claim=?",
      )
      .bind(runtime.now(), event.id, claim)
      .run();
    return response({ received: true });
  } catch (error) {
    await db
      .prepare(
        "UPDATE webhook_events SET status='pending',claim=NULL,lease_until=NULL WHERE id=? AND claim=?",
      )
      .bind(event.id, claim)
      .run();
    throw error;
  }
}
