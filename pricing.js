// Shared client-side pricing + helpers.
// ── Keep these numbers in sync with netlify/functions/config.js ──
const WEPAY = {
  HARDWARE_NGN: 590000,
  MONTHLY_NGN: 57000,
  GROUP_SIZES: [10, 15, 20, 25, 30, 40, 50],
  DEFAULT_GROUP_SIZE: 30,
  PLANS: [
    { months: 1, label: '1 Month' },
    { months: 3, label: '3 Months' },
    { months: 6, label: '6 Months', featured: true },
    { months: 12, label: '12 Months' },
  ],
  // WePay's cut — applied only at the payment step, never on marketing pages.
  // Founding = 3% (low entry price); renewals = 7% (ongoing managed service).
  FOUNDING_FEE_PCT: 0.03,
  RENEWAL_FEE_PCT: 0.07,
  naira(n) { return '₦' + Number(n).toLocaleString('en-NG'); },
  // Founding share: hardware + subscription. Renewal share: subscription only.
  quote(months, size) { return Math.ceil((this.HARDWARE_NGN + months * this.MONTHLY_NGN) / size); },
  renewalQuote(months, size) { return Math.ceil((months * this.MONTHLY_NGN) / size); },
  serviceFee(base, pct) { return Math.ceil(base * (pct == null ? this.FOUNDING_FEE_PCT : pct)); },
  payable(base, pct) { return base + this.serviceFee(base, pct); },
  planLabel(m) { return ({ 1: '1 Month', 3: '3 Months', 6: '6 Months', 12: '12 Months' }[m] || m + ' Months'); },
};
