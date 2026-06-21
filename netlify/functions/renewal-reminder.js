const nodemailer = require('nodemailer');
const { getSupabase, PLANS, createRenewalCycle } = require('./config');

const supabase = getSupabase();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
const REMINDER_WINDOW_DAYS = 14;

// Scheduled daily (see netlify.toml). Two passes:
//   1. REMIND — active groups whose Starlink bills within the next 14 days
//      and that haven't been reminded for this cycle yet: auto-open a
//      renewal cycle if none is open, email every member + the champion
//      their share, then stamp renewal_reminded_at (fires once per cycle).
//   2. LAPSE — active groups whose Starlink billing date has passed without
//      a fully-paid renewal: mark them 'lapsed' (WePay never fronts the
//      next month by default). The 7-day grace lives BEFORE the billing
//      date (expires_at), so a lapse only happens after the real deadline.
exports.handler = async () => {
  const now = new Date();
  const cutoff = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const { data: groups, error } = await supabase
    .from('groups')
    .select('*')
    .eq('status', 'active')
    .not('starlink_renews_on', 'is', null)
    .lte('starlink_renews_on', cutoff.toISOString())
    .is('renewal_reminded_at', null);

  if (error) {
    console.error('Reminder query error:', error);
    return { statusCode: 500, body: 'query failed' };
  }

  const bankName = process.env.WEPAY_BANK_NAME || 'WePay Collections (set WEPAY_BANK_NAME)';
  const bankAccount = process.env.WEPAY_ACCOUNT_NUMBER || '0000000000';
  const bankAccountName = process.env.WEPAY_ACCOUNT_NAME || 'WePay';
  const siteUrl = process.env.SITE_URL || '';

  let remindedCount = 0;

  for (const group of groups || []) {
    try {
      // Make sure a renewal cycle is open so members can pay right away.
      let perPay;
      const { data: open } = await supabase
        .from('renewals')
        .select('id')
        .eq('group_id', group.id)
        .eq('status', 'collecting')
        .limit(1);

      if (open && open.length) {
        const { data: sample } = await supabase
          .from('renewal_payments')
          .select('amount')
          .eq('renewal_id', open[0].id)
          .limit(1);
        perPay = sample && sample.length ? sample[0].amount : 0;
      } else {
        const cycle = await createRenewalCycle(group, group.plan_months);
        perPay = cycle.perPay;
      }

      const { data: members } = await supabase
        .from('members')
        .select('first_name, email')
        .eq('group_id', group.id);

      const recipients = new Set();
      (members || []).forEach((m) => m.email && recipients.add(m.email.toLowerCase()));
      if (group.champion_email) recipients.add(group.champion_email.toLowerCase());

      const fmt = (iso) => new Date(iso).toLocaleDateString('en-NG', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
      const renewsOn = fmt(group.starlink_renews_on);
      // Members are asked to pay by the deadline (a week before billing) so
      // WePay has the money in hand before Starlink charges.
      const payBy = group.expires_at ? fmt(group.expires_at) : renewsOn;
      const dashUrl = `${siteUrl}/group.html?code=${group.code}`;

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0b1020;padding:32px;border-radius:14px;color:#e8ecf6;">
          <div style="text-align:center;margin-bottom:20px;font-size:22px;font-weight:800;color:#fff;">WePay</div>
          <h1 style="font-size:22px;color:#fff;margin:0 0 8px;">${group.name} renews on ${renewsOn}</h1>
          <p style="color:#9aa6c4;font-size:14px;line-height:1.7;">
            Your group's Starlink subscription is up for renewal soon. The dish is already set up,
            so renewals only cover the subscription — far cheaper than the first time.
          </p>
          <div style="background:#141a2e;border:1px solid #233056;border-radius:12px;padding:20px;margin-top:16px;">
            <p style="margin:0 0 6px;color:#9aa6c4;font-size:13px;">Your renewal share</p>
            <p style="margin:0 0 16px;color:#34d399;font-size:28px;font-weight:800;">${naira(perPay)}</p>
            <p style="margin:0 0 8px;color:#9aa6c4;font-size:13px;">Pay into:</p>
            <p style="margin:0;color:#fff;font-size:15px;line-height:1.8;">${bankName}<br/><strong>${bankAccount}</strong><br/>${bankAccountName}</p>
            <p style="margin:16px 0 0;color:#9aa6c4;font-size:12px;line-height:1.6;">Use your email as the transfer reference. Please pay by <strong style="color:#fff;">${payBy}</strong> so we can renew before Starlink bills on ${renewsOn} — that keeps your connection on without interruption.</p>
          </div>
          <p style="color:#9aa6c4;font-size:14px;margin-top:16px;">Track your group: <a href="${dashUrl}" style="color:#22d3ee;">${dashUrl}</a></p>
          <p style="text-align:center;font-size:12px;margin-top:24px;color:#6b7596;">WePay · Affordable internet, together.</p>
        </div>`;

      await Promise.all(
        [...recipients].map((to) =>
          transporter.sendMail({
            from: `"WePay" <${process.env.GMAIL_USER}>`,
            to,
            subject: `${group.name}: Starlink renews ${renewsOn} — your share is ${naira(perPay)}`,
            html,
          })
        )
      );

      await supabase.from('groups').update({ renewal_reminded_at: now.toISOString() }).eq('id', group.id);
      remindedCount++;
    } catch (e) {
      console.error(`Reminder failed for group ${group.id}:`, e);
      // Leave renewal_reminded_at unset so the next run retries this group.
    }
  }

  // ── Pass 2: lapse sweep ──────────────────────────────────────
  // Active groups whose Starlink billing date has now passed. If the
  // renewal money is already in (a fully-paid 'collecting' cycle just
  // awaiting Apply), leave them alone — admin only needs to click Apply.
  // Otherwise mark them 'lapsed'.
  let lapsedCount = 0;
  const { data: overdue, error: overdueErr } = await supabase
    .from('groups')
    .select('id, name')
    .eq('status', 'active')
    .not('starlink_renews_on', 'is', null)
    .lte('starlink_renews_on', now.toISOString());

  if (overdueErr) {
    console.error('Lapse query error:', overdueErr);
  } else {
    for (const group of overdue || []) {
      try {
        const { data: open } = await supabase
          .from('renewals')
          .select('id')
          .eq('group_id', group.id)
          .eq('status', 'collecting')
          .limit(1);

        if (open && open.length) {
          const { data: pays } = await supabase
            .from('renewal_payments')
            .select('payment_status')
            .eq('renewal_id', open[0].id);
          const list = pays || [];
          const fullyPaid = list.length > 0 && list.every((p) => p.payment_status === 'confirmed');
          if (fullyPaid) continue; // money's in — admin just needs to Apply
        }

        await supabase
          .from('groups')
          .update({ status: 'lapsed', lapsed_at: now.toISOString() })
          .eq('id', group.id);
        lapsedCount++;
      } catch (e) {
        console.error(`Lapse failed for group ${group.id}:`, e);
      }
    }
  }

  console.log(`Renewal reminder: reminded ${remindedCount}, lapsed ${lapsedCount} group(s).`);
  return { statusCode: 200, body: JSON.stringify({ reminded: remindedCount, lapsed: lapsedCount }) };
};
