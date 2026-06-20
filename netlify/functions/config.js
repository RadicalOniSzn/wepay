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

function quote(months, groupSize = DEFAULT_GROUP_SIZE) {
  const total = HARDWARE_NGN + months * MONTHLY_NGN;
  const perPerson = Math.ceil(total / groupSize);
  return { total, perPerson, groupSize, months };
}

// WePay's cut. Applied ONLY at the payment step (join confirmation,
// "how to pay" card, payment email) — never shown on the marketing
// pages, where the base share is the affordability headline.
const SERVICE_FEE_PCT = 0.03;
function serviceFee(base) {
  return Math.ceil(base * SERVICE_FEE_PCT);
}
function payable(base) {
  return base + serviceFee(base);
}

// Human-friendly invite code: 6 chars, no ambiguous 0/O/1/I/L.
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

module.exports = {
  getSupabase,
  HARDWARE_NGN,
  MONTHLY_NGN,
  GROUP_SIZES,
  DEFAULT_GROUP_SIZE,
  PLANS,
  quote,
  SERVICE_FEE_PCT,
  serviceFee,
  payable,
  generateCode,
};
