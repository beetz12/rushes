// Separate commercial deployment. Dry-run by default; personal resources are protected.
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
const run = promisify(execFile);
const { values } = parseArgs({ options: {
  'account-id': { type: 'string' }, 'expected-email': { type: 'string' },
  'stripe-account-id': { type: 'string' },
  'apply': { type: 'boolean', default: false }, 'secrets-file': { type: 'string' },
  'hosting': { type: 'boolean', default: false },
  'live-payments': { type: 'boolean', default: false },
}, strict: true });
const account = values['account-id'], email = values['expected-email'];
if (!account || !/^[a-f0-9]{32}$/.test(account) || !email) throw new Error('Explicit account id and expected email are required.');
const root = resolve(import.meta.dirname, '../..');
const node = join(homedir(), '.nvm/versions/node/v22.22.0/bin/node');
const wrangler = join(homedir(), '.nvm/versions/node/v22.22.0/lib/node_modules/wrangler/bin/wrangler.js');
const commandEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: account };
for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL']) delete commandEnv[name];
const identity = await run(node, [wrangler, 'whoami'], { env: commandEnv, timeout: 30000, maxBuffer: 65536 });
if (!identity.stdout.includes(account) || !identity.stdout.toLowerCase().includes(email.toLowerCase())) throw new Error('Cloudflare identity differs from the explicitly selected account.');
const source = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
const dirty = (await run('git', ['status', '--porcelain'], { cwd: root })).stdout;
if (dirty) throw new Error('Commit the reviewed source/config before preparing deployment.');
const tokenText = await readFile(join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'), 'utf8');
const token = tokenText.match(/^oauth_token\s*=\s*"([^"\r\n]+)"\s*$/m)?.[1];
if (!token) throw new Error('Configured Cloudflare OAuth credential is unavailable.');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Cloudflare request failed HTTP ${response.status}, code ${data.errors?.[0]?.code ?? 'unknown'}.`);
  return data.result;
}
const worker = 'rushes-browser', bucket = 'rushes-browser-raw', database = 'rushes-browser-data';
const subdomain = (await api('/workers/subdomain')).subdomain;
if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error('Invalid existing workers.dev subdomain.');
const url = `https://${worker}.${subdomain}.workers.dev`;
const buckets = await api('/r2/buckets');
const databases = await api('/d1/database');
let db = databases.find(item => item.name === database);
const migrationsDir = join(root, 'browser-worker/migrations');
const migrations = (await readdir(migrationsDir)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
if (!migrations.length) throw new Error('Numbered service migrations are required.');
if (db) {
  const tables = await api(`/d1/database/${db.uuid}/query`, 'POST', { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", params: [] });
  const names = tables.flatMap(result => result.results ?? []).map(row => row.name);
  if (names.some(name => name !== 'd1_migrations') && !names.includes('d1_migrations'))
    throw new Error('Existing database has no migration ledger. Review its baseline before applying migrations.');
  if (names.includes('d1_migrations')) {
    const ledger = await api(`/d1/database/${db.uuid}/query`, 'POST', { sql: 'SELECT name FROM d1_migrations', params: [] });
    if (ledger.flatMap(result => result.results ?? []).some(row => !migrations.includes(row.name)))
      throw new Error('Database contains a migration absent from this reviewed source.');
  }
}
const config = JSON.parse(await readFile(join(root, 'browser-worker/wrangler.jsonc'), 'utf8'));
if (config.name !== worker) throw new Error('The selected config does not name the commercial Worker.');
await stat(join(root, 'browser/dist/index.html'));
await stat(join(root, 'browser-worker/dist/worker.js'));
const secrets = values['secrets-file'] ? JSON.parse(await readFile(resolve(values['secrets-file']), 'utf8')) : {};
const secretNames = ['SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'STREAM_CUSTOMER_CODE'];
if (Object.keys(secrets).some(name => !secretNames.includes(name)) || Object.values(secrets).some(value => typeof value !== 'string')) throw new Error('Secret file contains an unexpected binding or invalid value.');
if (values['live-payments'] && !values.hosting) throw new Error('Live payments require the reviewed hosting deployment.');
if (values['secrets-file']) {
  const mode = (await stat(resolve(values['secrets-file']))).mode;
  if (mode & 0o077) throw new Error('Secret file must be private (0600).');
}
if (values.hosting) {
  for (const name of secretNames)
    if (!secrets[name]) throw new Error(`Hosting requires ${name}.`);
  const stripeMode = values['live-payments'] ? 'live' : 'test';
  if (![ `sk_${stripeMode}_`, `rk_${stripeMode}_` ].some(prefix => secrets.STRIPE_SECRET_KEY.startsWith(prefix))) throw new Error('Stripe credential mode differs from the explicitly selected payment mode.');
  if (secrets.CLOUDFLARE_ACCOUNT_ID !== account) throw new Error('Stream token/account mapping does not match deployment account.');
  const selectedStripeAccount = values['stripe-account-id'];
  if (!selectedStripeAccount || !/^acct_[a-zA-Z0-9]+$/.test(selectedStripeAccount)) throw new Error('Hosting requires the explicitly selected Stripe account id.');
  async function stripe(path) {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${secrets.STRIPE_SECRET_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Stripe validation failed HTTP ${response.status}.`);
    return response.json();
  }
  const selected = await stripe('account');
  if (selected.id !== selectedStripeAccount) throw new Error('Stripe credential belongs to a different account.');
  const price = await stripe(`prices/${encodeURIComponent(secrets.STRIPE_PRICE_ID)}`);
  if (!price.active || price.currency !== 'usd' || price.unit_amount !== 1500 || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.livemode !== values['live-payments'])
    throw new Error('Selected Stripe price differs from the reviewed $15/month payment mode.');
}
const plan = {
  source, account, expectedEmail: email, url, worker, bucket, database,
  createBucket: !buckets.buckets.some(item => item.name === bucket), createDatabase: !db,
  migrations, hosting: values.hosting, livePayments: values['live-payments'],
  secretNames: Object.keys(secrets), pilotBudgetUSD: 100, warningUSD: 75,
  personalResources: 'preserved',
};
if (!values.apply) { console.log(JSON.stringify({ dryRun: true, plan })); process.exit(0); }
if (plan.createBucket) await api('/r2/buckets', 'POST', { name: bucket });
if (!db) db = await api('/d1/database', 'POST', { name: database });
const scratch = join(root, 'browser-worker/.wrangler'); await mkdir(scratch, { recursive: true, mode: 0o700 });
const generated = { ...config, account_id: account,
  main: join(root, 'browser-worker/dist/worker.js'),
  assets: { ...config.assets, directory: join(root, 'browser/dist') },
  d1_databases: [{ binding: 'DB', database_name: database, database_id: db.uuid, migrations_dir: migrationsDir, migrations_table: 'd1_migrations' }],
  r2_buckets: [{ binding: 'RAW', bucket_name: bucket }],
  vars: { ...config.vars, PUBLIC_BASE_URL: url, REVISION: source, HOSTING_ENABLED: String(values.hosting), DELIVERY_ENABLED: String(values.hosting), SIGNUP_ENABLED: String(values.hosting), STRIPE_LIVE_ENABLED: String(values['live-payments']), INVITE_EMAILS: email },
};
const configPath = join(scratch, 'commercial-deploy.json');
await writeFile(configPath, JSON.stringify(generated, null, 2), { mode: 0o600 });
const migrated = await run(node, [wrangler, 'd1', 'migrations', 'apply', database, '--remote', '--config', configPath], { cwd: join(root, 'browser-worker'), env: { ...commandEnv, CI: 'true' }, timeout: 180000, maxBuffer: 131072 });
await writeFile(join(scratch, 'last-migrations.log'), migrated.stdout + migrated.stderr, { mode: 0o600 });
const ledger = await api(`/d1/database/${db.uuid}/query`, 'POST', { sql: 'SELECT name FROM d1_migrations', params: [] });
const applied = ledger.flatMap(result => result.results ?? []).map(row => row.name);
if (!migrations.every(name => applied.includes(name))) throw new Error('Remote read-back does not contain every reviewed migration.');
const deploy = await run(node, [wrangler, 'deploy', '--config', configPath, '--no-autoconfig'], { cwd: join(root, 'browser-worker'), env: commandEnv, timeout: 180000, maxBuffer: 131072 });
// Wrangler output contains no supplied secret values; retain exact artifact/deploy paths.
await writeFile(join(scratch, 'last-deploy.log'), deploy.stdout + deploy.stderr, { mode: 0o600 });
if (Object.keys(secrets).length) {
  const secretsPath = join(scratch, 'commercial-secrets.json'); await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
  await run(node, [wrangler, 'secret', 'bulk', secretsPath, '--config', configPath], { cwd: join(root, 'browser-worker'), env: commandEnv, timeout: 60000, maxBuffer: 65536 });
}
const probe = await fetch(url + '/api/config', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
const actual = await probe.json();
if (!probe.ok || actual.revision !== source || actual.hostingEnabled !== values.hosting) throw new Error('Live configuration does not match the reviewed revision/mode.');
console.log(JSON.stringify({ applied: true, plan, databaseId: db.uuid, configVerified: true, authenticatedProviderAcceptanceStillRequired: values.hosting }));
