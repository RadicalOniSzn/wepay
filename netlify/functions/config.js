const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ──────────────────────────────────────────────────────────────
// PRICING MODEL  (all amounts in Nigerian Naira)
//
// PLACEHOLDER PRICES — verify against current Starlink Nigeria
// pricing before launch. A group buys ONE Starlink kit (hardware,
// paid once) plus N months of subscription, then splits the total
// across everyone in the group.
// ──────────────────────────────────────────────────────────────
const HARDWARE_NGN = 590000; // one-time Starlink Standard hardware kit
const MONTHLY_NGN = 57000; // monthly residential subscription

// Sensible per-dish group sizes. One dish shares its bandwidth
// across everyone, so this is capped — not "as many as possible".
const GROUP_SIZES = [10, 15, 20, 25, 30, 40, 50];
const DEFAULT_GROUP_SIZE = 30;

const PLANS = {
  1: { months: 1, label: '1 Month' },
  3: { months: 3, label: '3 Months' },
  6: { months: 6, label: '6 Months' },
  12: { months: 12, label: '12 Months' },
};

// FOUNDING purchase: one Starlink kit (hardware, paid once) + N months
// of subscription, split across the group. This sets the group up.
function quote(months, groupSize = DEFAULT_GROUP_SIZE) {
  const total = HARDWARE_NGN + months * MONTHLY_NGN;
  const perPerson = Math.ceil(total / groupSize);
  return { total, perPerson, groupSize, months };
}

// RENEWAL: the dish already exists and WePay owns it, so a renewal covers
// the subscription ONLY — no hardware. Members are buying continued access,
// not the hardware again.
function renewalQuote(months, groupSize = DEFAULT_GROUP_SIZE) {
  const total = months * MONTHLY_NGN;
  const perPerson = Math.ceil(total / groupSize);
  return { total, perPerson, groupSize, months };
}

// WePay's cut. Applied ONLY at the payment step (join confirmation,
// "how to pay" card, payment email) — never shown on the marketing
// pages, where the base share is the affordability headline.
//   • Founding = 3% (keep the entry price low to win the group).
//   • Renewal  = 7% (WePay's ongoing managed service: paying Starlink,
//                     account management, support).
const FOUNDING_FEE_PCT = 0.03;
const RENEWAL_FEE_PCT = 0.07;
function serviceFee(base, pct = FOUNDING_FEE_PCT) {
  return Math.ceil(base * pct);
}
function payable(base, pct = FOUNDING_FEE_PCT) {
  return base + serviceFee(base, pct);
}

// Open a renewal cycle for a group: one `renewals` row plus a pending
// `renewal_payments` row for every current member. The subscription-only
// cost is split across the people actually in the group, and each member's
// amount carries the 7% renewal fee. Returns { renewal, perPay, count }.
// Shared by open-renewal.js (admin) and renewal-reminder.js (scheduled).
async function createRenewalCycle(group, months) {
  const supabase = getSupabase();
  const { data: members } = await supabase
    .from('members')
    .select('id')
    .eq('group_id', group.id);
  const list = members || [];
  const size = list.length || group.target_size;
  const base = renewalQuote(months, size).perPerson;
  const perPay = payable(base, RENEWAL_FEE_PCT);

  const { data: renewal, error } = await supabase
    .from('renewals')
    .insert([{ group_id: group.id, months, per_person: base, status: 'collecting' }])
    .select()
    .single();
  if (error || !renewal) throw error || new Error('Could not create renewal cycle.');

  if (list.length) {
    const { error: payErr } = await supabase.from('renewal_payments').insert(
      list.map((m) => ({
        renewal_id: renewal.id,
        member_id: m.id,
        amount: perPay,
        payment_status: 'pending',
      }))
    );
    if (payErr) throw payErr;
  }

  return { renewal, perPay, count: list.length };
}

// ──────────────────────────────────────────────────────────────
// SUBSCRIPTION LIFECYCLE DATES
//
// Each active group tracks TWO dates:
//   • starlink_renews_on — the REAL date Starlink bills WePay. WePay
//     must have collected the renewal by then.
//   • expires_at — the MEMBER deadline, set GRACE_BUFFER_DAYS *before*
//     the billing date. The gap is collection runway: members are
//     nudged to pay by expires_at, but the connection (already paid for
//     this term) stays on until starlink_renews_on. So the buffer costs
//     nobody — it lives inside the term the group already funded.
// If a group reaches starlink_renews_on unpaid it is marked 'lapsed'
// (WePay never fronts the next month by default).
// ──────────────────────────────────────────────────────────────
const GRACE_BUFFER_DAYS = 7;

// Given a start date + term length, return the real billing date and the
// member deadline (billing date minus the grace buffer).
function termDates(fromDate, months) {
  const renewsOn = new Date(fromDate);
  renewsOn.setMonth(renewsOn.getMonth() + Number(months || 0));
  return { renewsOn, deadline: deadlineFor(renewsOn) };
}

// The member deadline for a given Starlink billing date.
function deadlineFor(renewsOn) {
  const deadline = new Date(renewsOn);
  deadline.setDate(deadline.getDate() - GRACE_BUFFER_DAYS);
  return deadline;
}

// Human-friendly invite code: 6 chars, no ambiguous 0/O/1/I/L.
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Secret per-group token that lets the champion manage the group (e.g. remove
// non-paying members) via a private link, without a full login. Long + random
// so it can't be guessed: 36 hex chars.
function generateManageToken() {
  return crypto.randomBytes(18).toString('hex');
}

module.exports = {
  getSupabase,
  HARDWARE_NGN,
  MONTHLY_NGN,
  GROUP_SIZES,
  DEFAULT_GROUP_SIZE,
  PLANS,
  quote,
  renewalQuote,
  FOUNDING_FEE_PCT,
  RENEWAL_FEE_PCT,
  serviceFee,
  payable,
  createRenewalCycle,
  GRACE_BUFFER_DAYS,
  termDates,
  deadlineFor,
  generateCode,
  generateManageToken,
};
