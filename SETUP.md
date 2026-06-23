# WePay — Setup & Deployment Guide

WePay helps a group that's already gathered in one place — a **hostel, camp or
compound** — share a single Starlink connection. One person (the **champion**)
starts a group, gets an **invite code**, and shares it. Hostel-mates join with the
code, each sees their small **share** of the cost, pays into one account, and WePay
sets up the connection once the group is funded.

## What's included
| File | Purpose |
|------|---------|
| `index.html` | Landing page (Start a group / Join with a code) |
| `start.html` | Champion creates a group and gets an invite code |
| `join.html` | Join a group with an invite code (works from `?code=XXXXXX` links) |
| `group.html` | Group dashboard by code — progress, payments, member list (champion + members) |
| `admin.html` | WePay admin — all groups, confirm payments, change group status |
| `styles.css` / `pricing.js` | Shared styling + client-side pricing |
| `netlify/functions/config.js` | Shared pricing model, code generator, Supabase client |
| `netlify/functions/create-group.js` | Champion creates a group (becomes first member) |
| `netlify/functions/join-group.js` | Join a group by invite code |
| `netlify/functions/group-status.js` | Public group lookup by code |
| `netlify/functions/get-groups.js` | Returns all groups + members to admin |
| `netlify/functions/mark-paid.js` | Admin confirms / un-confirms a payment |
| `netlify/functions/update-group.js` | Admin changes a group's status (sets the subscription expiry on first activation) |
| `netlify/functions/admin-auth.js` | Admin login |
| `netlify/functions/open-renewal.js` | Admin opens a renewal cycle and emails each member their subscription-only share |
| `netlify/functions/mark-renewal-paid.js` | Admin confirms / un-confirms a renewal payment |
| `netlify/functions/apply-renewal.js` | Admin applies a fully-paid renewal — extends the group's expiry |
| `netlify/functions/renewal-reminder.js` | Scheduled daily — emails groups whose Starlink expires within 14 days |
| `netlify/functions/remove-member.js` | Removes an unpaid, non-champion member (admin password OR the group's manage token) |

---

## ⚠️ Before launch — update the pricing
Open `netlify/functions/config.js` **and** `pricing.js` (marked "keep in sync").
The numbers there reflect **current Starlink Nigeria prices (verified 2026-06)**:

```
HARDWARE_NGN     = 590000  // one-time Starlink Standard kit
MONTHLY_NGN      = 57000   // monthly residential subscription
GROUP_SIZES      = [10..50] // selectable per-dish group sizes
FOUNDING_FEE_PCT = 0.03    // WePay's cut on founding — added at payment only
RENEWAL_FEE_PCT  = 0.07    // WePay's cut on renewals — added at payment only
```

The service fee is **folded into every share members see** — the marketing plan
prices, the start-a-group quote, the dashboard "share each", and the join/pay
screens and emails all show the fee-inclusive amount, so the figure shown is
exactly what people transfer. A short *"includes a small 3% service fee for setup
& management"* note explains it. The admin dashboard still shows each member's
real (fee-inclusive) amount plus a separate **Service fees** stat for the total
WePay has collected in fees.

**Two pricing models** (see `config.js`):
- **Founding** (`quote`) = `ceil((HARDWARE + months × MONTHLY) / size)`, +3% fee.
  This is the setup-plus-first-term payment. WePay owns and manages the equipment.
- **Renewal** (`renewalQuote`) = `ceil((months × MONTHLY) / size)`, +7% fee.
  Subscription only (no hardware) — members chip in to keep the connection on
  when a term ends. Split across the **current** member count.

Verify the **current** Starlink Nigeria prices and update both files so the
per-person amounts shown to users are accurate. Note: one dish shares its bandwidth
across the whole group, so keep group sizes sensible for a good experience.

---

## Step 1 — Create a Supabase database (free)
1. Go to [supabase.com](https://supabase.com) → create an account → **New Project** → name it `wepay`.
2. Open the **SQL Editor** and run this:

```sql
create table groups (
  id            bigint generated always as identity primary key,
  code          text   not null unique,
  name          text   not null,
  venue         text,
  state         text,
  plan_months   int    not null,
  target_size   int    not null,
  per_person    bigint not null,
  total_cost    bigint not null,
  champion_name  text,
  champion_email text,
  champion_phone text,
  status        text   not null default 'forming', -- forming | full | funded | active | cancelled
  created_at    timestamptz default now()
);

create table members (
  id             bigint generated always as identity primary key,
  group_id       bigint references groups(id) on delete cascade,
  first_name     text   not null,
  last_name      text   not null,
  email          text   not null,
  phone          text,
  amount         bigint not null,
  is_champion    boolean not null default false,
  payment_status text   not null default 'pending', -- pending | confirmed
  paid_at        timestamptz,
  created_at     timestamptz default now(),
  unique (email, group_id)
);

create index members_group_idx on members (group_id);
create index groups_code_idx    on groups (code);
```

3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** key → `SUPABASE_SERVICE_KEY`

---

## Step 1b — Renewal model (run if upgrading an existing database)
The renewal/managed-service flow adds an expiry to each group plus two tables for
renewal cycles and their per-member payments. If your database predates the
renewal feature, run this once in the **SQL Editor**:

```sql
-- Track each group's managed-subscription lifecycle
alter table groups add column if not exists activated_at        timestamptz;
alter table groups add column if not exists expires_at          timestamptz;
alter table groups add column if not exists renewal_reminded_at timestamptz;

-- A renewal cycle = one subscription-only collection round for a group
create table if not exists renewals (
  id          bigint generated always as identity primary key,
  group_id    bigint references groups(id) on delete cascade,
  months      int    not null,
  per_person  bigint not null,                 -- base share, before fee
  status      text   not null default 'collecting', -- collecting | applied
  created_at  timestamptz default now(),
  applied_at  timestamptz
);
create index if not exists renewals_group_idx on renewals (group_id);

-- One row per member per renewal cycle (amount includes the renewal fee)
create table if not exists renewal_payments (
  id             bigint generated always as identity primary key,
  renewal_id     bigint references renewals(id) on delete cascade,
  member_id      bigint references members(id) on delete cascade,
  amount         bigint not null,
  payment_status text   not null default 'pending', -- pending | confirmed
  paid_at        timestamptz,
  created_at     timestamptz default now(),
  unique (renewal_id, member_id)
);
create index if not exists renewal_payments_renewal_idx on renewal_payments (renewal_id);

-- RLS on (no policies — only the service_role key reaches these tables)
alter table renewals         enable row level security;
alter table renewal_payments enable row level security;
```

> Starting a **fresh** database? Run this block right after the Step 1 schema.

---

## Step 1c — Two-date model + grace/lapse (run if upgrading)
WePay tracks **two** dates per active group:
- `starlink_renews_on` — the **real** date Starlink bills WePay.
- `expires_at` — the **member deadline**, kept `GRACE_BUFFER_DAYS` (default **7**)
  *before* the billing date. The gap is collection runway: the connection (already
  funded for the current term) stays on until `starlink_renews_on`, so the buffer
  costs nobody. A group that reaches `starlink_renews_on` unpaid is marked
  **`lapsed`** (WePay never fronts the next month by default).

```sql
alter table groups add column if not exists starlink_renews_on timestamptz;
alter table groups add column if not exists lapsed_at          timestamptz;

-- Migrate existing rows: the old expires_at WAS the billing date, so move it to
-- starlink_renews_on and pull expires_at back by the 7-day grace buffer.
update groups
   set starlink_renews_on = expires_at,
       expires_at         = expires_at - interval '7 days'
 where starlink_renews_on is null
   and expires_at is not null;
```

`GRACE_BUFFER_DAYS` lives in `netlify/functions/config.js` — change it there if you
ever want a different buffer.

---

## Step 1d — Remove non-paying members (run if upgrading)
Each group gets a secret **`manage_token`**. It powers the champion's private
manage link (`group.html?code=XXXXXX&manage=<token>`), which lets the champion —
and the WePay admin — remove members who joined but never paid, so abandoners
don't hold up a group by occupying slots. Only **pending** (unpaid) members can be
removed, never the champion or anyone who has paid; removal is a hard delete.

```sql
alter table groups add column if not exists manage_token text;

-- Backfill existing groups with a random token so their champions get a link too.
update groups
   set manage_token = replace(gen_random_uuid()::text, '-', '')
 where manage_token is null;
```

> Starting a **fresh** database? New groups get a token automatically on creation,
> but run this once anyway so any rows created before deploy are covered.

---

## Step 2 — Gmail App Password (for emails)
1. [myaccount.google.com](https://myaccount.google.com) → **Security** → turn on **2-Step Verification**.
2. Search **App Passwords** → create one for "Mail" → name it `WePay`.
3. Copy the 16-character password → `GMAIL_APP_PASSWORD`.

---

## Step 3 — Deploy to Netlify (free)
**Drag & drop:** drag the `wepay` folder onto [app.netlify.com](https://app.netlify.com).
**Or via Git:** push to GitHub → Netlify → *Add new site → Import from Git*.

---

## Step 4 — Environment variables (Netlify → Site configuration → Environment variables)
| Key | Value |
|-----|-------|
| `SUPABASE_URL` | From Step 1 |
| `SUPABASE_SERVICE_KEY` | From Step 1 |
| `GMAIL_USER` | The Gmail address that sends emails |
| `GMAIL_APP_PASSWORD` | From Step 2 |
| `ADMIN_PASSWORD` | A strong password for the admin dashboard |
| `ADMIN_NOTIFY_EMAILS` | Comma-separated emails to notify on each new group |
| `SITE_URL` | Your live URL (used to build invite links in emails) |
| `WEPAY_BANK_NAME` | Bank that holds the collection account |
| `WEPAY_ACCOUNT_NUMBER` | The single account people pay into |
| `WEPAY_ACCOUNT_NAME` | Account holder name |

Re-deploy after adding variables.

---

## Step 5 — Use it
- **Public site:** `https://your-site.netlify.app/`
- **Start a group:** `/start.html`
- **Join with a code:** `/join.html` (or `/join.html?code=XXXXXX`)
- **Group dashboard:** `/group.html?code=XXXXXX`
- **Admin:** `/admin.html` (log in with `ADMIN_PASSWORD`)

### The flow
1. A champion starts a group at `/start.html` → gets an invite **code** + a shareable link, and is added as the first member.
2. They share the code in their hostel WhatsApp group. Members join at `/join.html` and see their share.
3. Everyone pays their share into the WePay bank account (using their email as the reference).
4. In **admin**, click **Confirm paid** as payments arrive.
5. When everyone has paid, set the group to **funded**, then **active** once the dish is installed.
   Marking a group **active** for the first time starts the subscription clock:
   `activated_at`, the real Starlink billing date `starlink_renews_on`
   (activation + plan length), and the member deadline `expires_at`
   (billing date − 7-day grace buffer).

The champion and members can track progress any time at `/group.html?code=...`
(names + payment status are visible to anyone with the code).

### Removing members who never pay
If someone joins but never pays and just abandons the group, they tie up a slot
and the people who *did* pay are stuck. Both the **champion** and the **admin**
can remove such members:
- **Champion:** uses their private manage link (`/group.html?code=XXXXXX&manage=<token>`),
  sent in their welcome email and on the create-group success page. A **Remove**
  button appears next to each unpaid member.
- **Admin:** a **Remove** button shows next to each unpaid member in `/admin.html`.

Only **unpaid** members can be removed — the champion and anyone who has already
paid are protected. Removal is permanent (hard delete); the person can re-join
later with the invite code if a slot is free.

### Renewals (managed service)
WePay owns and manages each dish, so when a term nears its end members just
re-up the subscription — no new hardware.

**Two dates, one buffer.** Members are asked to pay by `expires_at`, which sits
7 days *before* the real Starlink billing date (`starlink_renews_on`). Those 7
days are collection runway *inside* the term the group already paid for, so the
grace period costs nobody. You can correct the real billing date any time in
**admin** (the *Starlink billing date* field) — the deadline auto-follows it.

1. The scheduled **renewal-reminder** function runs daily. ~14 days before a
   group's `starlink_renews_on`, it opens a renewal cycle automatically and emails
   every member + the champion their subscription-only share (split across the
   current members, +7% renewal fee), telling them to pay by `expires_at`. You can
   also open one manually in **admin** with the term dropdown → **Open renewal**.
2. Members pay their renewal share into the same WePay account.
3. In **admin**, confirm each renewal payment as it arrives.
4. Once everyone has paid, click **Apply renewal** — this pushes
   `starlink_renews_on` forward by the renewal term (stacking from the later of now
   / current billing date), recomputes `expires_at`, clears the reminder flag, and
   revives the group to **active** if it had lapsed.
5. **Lapse sweep:** the same daily job marks a group **`lapsed`** once
   `starlink_renews_on` passes without a fully-paid renewal (a paid-but-not-yet
   *Applied* cycle is left alone). WePay never fronts the next month by default —
   the connection drops until the group pays, then **Apply renewal** brings it back.

---

## Real-world reminder
WePay assumes the group is **physically together** (one hostel/block/compound) — a
Starlink router only reaches ~30–150 m, and one dish shares its bandwidth across the
group. Keep groups to people actually in range of the same dish, and size them so
the connection stays fast.

## Local development (optional)
```
npm install
npx netlify dev
```
Runs the static pages **and** the serverless functions together at `localhost:8888`.
Opening the HTML files directly (file://) shows the pages, but join/create/admin
calls need the functions running (and the env vars set).
