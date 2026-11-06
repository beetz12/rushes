# Self-host sharing

Rushes share links play from storage you own. This guide sets that up once.
After that, Share in the review window uploads the video and copies the link.

There are two choices:

| | Worker (recommended) | Bucket |
|---|---|---|
| What it is | A small Cloudflare Worker plus R2 storage and a D1 database, in your Cloudflare account | Any S3-compatible bucket with public reads (Cloudflare R2, AWS S3, Backblaze B2 and similar) |
| Share page | Player, captions, chapters, transcript | Player, captions, chapters, transcript |
| Passwords and expiry | Yes | No |
| Comments, reactions, view counts | Yes | No |
| Embeds (Notion, websites) | Yes | No |
| Setup time | About 15 minutes | About 10 minutes |

Cloudflare's free tier covers light personal use. R2 needs a payment method
on file before you can turn it on. Check Cloudflare's current pricing for
your expected storage and traffic; Rushes does not bill you for anything.

## Option A: Worker

### In the app (recommended)

1. In Rushes, open **Settings → Sharing** and choose **Set up sharing for me**.
2. **Create a Cloudflare API token.** Choose **Open Cloudflare API Tokens**,
   then **Create Token → Create Custom Token**. Add exactly these
   permissions:
   - Account → Workers Scripts → Edit
   - Account → Workers R2 Storage → Edit
   - Account → D1 → Edit
   - Account → Account Settings → Read

   Under Account Resources, include your account. Create the token, copy it
   and paste it into Rushes. Rushes uses it for this setup only and does
   not save it.
3. **Choose account.** If the account has no `workers.dev` address yet,
   pick a name; Rushes creates it. An existing name is used as is and never
   renamed.
4. **Set up.** Rushes creates the Worker (`rushes-share`), the R2 bucket
   (`rushes-media`) and the D1 database (`rushes-share`), waits for the
   Worker to answer, saves its address and owner token in macOS secure
   storage, and tests the connection.
5. Record a short take and choose Share. The link is copied to your
   clipboard.

If setup stops:

- **R2 is not turned on**: open R2 Object Storage in the Cloudflare
  dashboard, turn it on (Cloudflare asks for a payment method), then choose
  **Try again**.
- **Missing permission or token not accepted**: edit the token so it has
  the four permissions above, then paste it again.
- **Stopped partway**: choose **Try again**. Setup reuses the same names, so
  nothing is duplicated.

You can delete the token in Cloudflare after setup finishes.

### From a terminal (alternative)

#### What you need

- A Cloudflare account.
- R2 turned on in that account (Cloudflare Dashboard → R2 → enable).
- A `workers.dev` subdomain (Dashboard → Workers & Pages; Cloudflare asks
  you to pick one the first time).
- Node 22.22.0 installed with nvm, and Wrangler installed for that Node:
  `npm install -g wrangler`.
- A clone of this repository, built once:

  ```bash
  npm ci --prefix viewer && npm run build --prefix viewer
  npm ci --prefix worker && npm run build --prefix worker
  npm ci --prefix cloud && npm run build --prefix cloud
  ```

#### Steps

1. Sign in to Cloudflare with Wrangler. This opens your browser.

   ```bash
   wrangler login
   ```

2. Find your account ID. It is a 32-character hex string shown by
   `wrangler whoami` and on the right side of the Cloudflare Dashboard.

3. Run the setup in dry-run mode first. It changes nothing and prints what it
   would create.

   ```bash
   node cloud/scripts/deploy-wrangler.mjs \
     --account-id <your-account-id> \
     --expected-email <the-email-you-log-in-with>
   ```

   If it reports `R2_NOT_ENABLED`, turn on R2 in the Dashboard and run it
   again. If it reports `SUBDOMAIN_REQUIRED`, add
   `--workers-subdomain <name>` with the name you want.

4. Open Rushes. The setup hands your new share credentials straight to the
   running app over its private local socket, so they never touch a file.

5. Run the same command again with `--apply`. This creates the Worker
   (`rushes-share`), the R2 bucket (`rushes-media`) and the D1 database
   (`rushes-share`), then checks they respond.

   ```bash
   node cloud/scripts/deploy-wrangler.mjs \
     --account-id <your-account-id> \
     --expected-email <the-email-you-log-in-with> \
     --apply
   ```

6. In Rushes, open Settings → Sharing. The provider shows **Rushes share
   Worker**. Choose **Test connection**.

7. Record a short take and choose Share. The link is copied to your
   clipboard.

#### If something fails

- The setup never reports success after a partial deploy. Run the dry run
  again to see what exists, then `--apply` again; it reuses resources with
  the same names.
- If Rushes was not open in step 5, the command refuses to continue. Open
  Rushes and run it again.
- Removing everything: delete the `rushes-share` Worker, the `rushes-media`
  bucket and the `rushes-share` database in the Cloudflare Dashboard.

## Option B: Bucket

1. Create a bucket in your storage provider and allow public reads for its
   objects (for R2: turn on the bucket's public `r2.dev` URL or attach a
   custom domain).
2. Create an access key that can read and write that bucket only.
3. In Rushes, open Settings → Sharing and choose **S3 / Cloudflare R2
   bucket**. Fill in the endpoint, region, bucket, public URL, access key ID
   and secret, then choose **Save settings**.
4. Choose **Test connection**, then share a take.

Rushes stores the secret in the macOS Keychain through Electron's
safeStorage. It is never written to a plain file.

## Privacy notes

- Rushes only uploads the exported share MP4, its poster frame, captions
  and transcript. Your original track files never leave your Mac.
- Unsharing deletes the uploaded files from your storage.
- With the Worker, view counts are recorded only when someone presses play.
