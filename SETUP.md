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
| `netlify/functions/update-group.js` | Admin changes a group's status |
| `netlify/functions/admin-auth.js` | Admin login |

---

## ⚠️ Before launch — update the pricing
Open `netlify/functions/config.js` **and** `pricing.js` (marked "keep in sync").
The numbers there reflect **current Starlink Nigeria prices (verified 2026-06)**:

```
HARDWARE_NGN    = 590000   // one-time Starlink Standard kit
MONTHLY_NGN     = 57000    // monthly residential subscription
GROUP_SIZES     = [10..50] // selectable per-dish group sizes
SERVICE_FEE_PCT = 0.03     // WePay's cut — added at payment only
```

`SERVICE_FEE_PCT` is **deliberately hidden** from the marketing pages: every
page shows the base share, and the 3% is folded into the amount people actually
transfer (join confirmation, the "How to pay" card, and the payment email). The
admin dashboard's **Service fees** stat shows the total collected.

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

The champion and members can track progress any time at `/group.html?code=...`
(names + payment status are visible to anyone with the code).

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
