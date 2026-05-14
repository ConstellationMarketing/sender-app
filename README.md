# Sender — Reports & Newsletters

Standalone Node.js service for sending monthly client reports, newsletters,
and bulk personalized emails. Replaces GoHighLevel.

Same pattern as SPR0 and Meerkat: Express + static frontend + Supabase,
managed by PM2 on the VPS, exposed via Cloudflare Tunnel, iframed from the
OS bots list.

## What's inside

| File | Purpose |
|---|---|
| `server.js` | Express server — serves `/api/*` JSON and `public/` static |
| `routes/api.js` | API endpoints: `/api/health`, `/api/snapshot` |
| `lib/supabase.js` | Service-role Supabase client for the `sender_*` tables |
| `public/index.html` | Full frontend — single HTML, internal nav, vanilla JS |
| `pm2.json` | PM2 config for the VPS |
| `.env.example` | Env-var template |

## Run locally

```bash
cd sender-app
cp .env.example .env
# edit .env — paste SUPABASE_SERVICE_ROLE_KEY from Supabase Settings → API
npm install
npm run dev
```

Open http://localhost:3010.

You'll see the Dashboard with KPIs at 0 and empty states. Pages: Dashboard,
Monthly Reports, Newsletters, Client Lists, Templates, Upload CSV, Send Queue,
Email Logs, Settings (lists OS users from `users_profiles`).

To populate any page, insert rows in the corresponding `sender_*` Supabase
table. The frontend re-fetches `/api/snapshot` on every page load.

## Deploy to VPS

Matches the pattern used by SPR0 and Meerkat at `45.55.248.2`.

```bash
ssh root@45.55.248.2
cd /root
git clone https://github.com/ConstellationMarketing/sender-app.git
cd sender-app
npm install --omit=dev
cp .env.example .env
# paste real SUPABASE_SERVICE_ROLE_KEY
pm2 start pm2.json
pm2 save
```

Then add a Cloudflare Tunnel route for `sender.goconstellation.com → localhost:3010` (same way `meerkat-api.goconstellation.com` is set up).

## Hook into the OS bots list

In `constellation-os/os/src/lib/data/bots.js`, add:

```js
{
  id: 'sender',
  name: 'Reports & Newsletters',
  icon: '✉️',
  url: 'https://sender.goconstellation.com/',
  team: 'Client Strategy',
  description: 'Send monthly client reports, newsletters, and bulk personalized emails.',
},
```

The card opens the Sender inside an iframe (same pattern as Meerkat).

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok: true, env: { ... } }` |
| GET | `/api/snapshot` | `{ kpis, recipients, lists, templates, batches, queue, logs, users }` |

## Tables it reads

All in the master Supabase project (`cwligyakhxevopxiksdm`), public schema:
- `sender_clients_recipients`
- `sender_clients_lists`
- `sender_clients_list_members`
- `sender_templates_emails`
- `sender_sends_batches`
- `sender_sends_emails`
- `sender_logs_events`
- `users_profiles` (read only, for the Settings page)

Schema was created earlier — run `supabase-schema.sql` from the original
`reports-newsletters-sender/` Next.js folder if you haven't yet.

## Next steps

- Forms to create rows (new template, list, batch) — POST endpoints in `routes/api.js`
- Mailgun integration — `POST /api/send` pushes to a job queue
- Mailgun webhooks → `sender_logs_events`
- Real-time queue updates (Supabase Realtime)
