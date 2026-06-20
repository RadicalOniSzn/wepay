const nodemailer = require('nodemailer');
const { getSupabase, PLANS, createRenewalCycle } = require('./config');

const supabase = getSupabase();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
const REMINDER_WINDOW_DAYS = 14;

// Scheduled daily (see netlify.toml). Finds active groups whose Starlink
// expires within the next 14 days and that haven't been reminded for this
// cycle yet. For each: auto-opens a renewal cycle if none is open, emails
// every member + the champion their renewal share, then stamps
// renewal_reminded_at so it only fires once per cycle.
exports.handler = async () => {
  const now = new Date();
  const cutoff = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const { data: groups, error } = await supabase
    .from('groups')
    .select('*')
    .eq('status', 'active')
    .not('expires_at', 'is', null)
    .lte('expires_at', cutoff.toISOString())
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

      const renewsOn = new Date(group.expires_at).toLocaleDateString('en-NG', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
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
            <p style="margin:16px 0 0;color:#9aa6c4;font-size:12px;line-height:1.6;">Use your email as the transfer reference. Keep the connection on without interruption by paying before ${renewsOn}.</p>
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

  console.log(`Renewal reminder: processed ${remindedCount} group(s).`);
  return { statusCode: 200, body: JSON.stringify({ reminded: remindedCount }) };
};
