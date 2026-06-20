const nodemailer = require('nodemailer');
const { getSupabase, PLANS, createRenewalCycle } = require('./config');

const supabase = getSupabase();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');

// Admin opens a renewal cycle for a group: subscription-only, split across
// current members, each carrying the 7% renewal fee. Emails every member
// their share + how to pay. Reused by the scheduled reminder via config.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const password = event.headers['x-admin-password'];
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) };
  }

  const { groupId } = body;
  const months = Number(body.months);
  if (!groupId || !PLANS[months]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'groupId and a valid renewal term are required.' }) };
  }

  const { data: group, error: gErr } = await supabase.from('groups').select('*').eq('id', groupId).single();
  if (gErr || !group) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Group not found.' }) };
  }

  // Only one open cycle at a time.
  const { data: open } = await supabase
    .from('renewals')
    .select('id')
    .eq('group_id', groupId)
    .eq('status', 'collecting')
    .limit(1);
  if (open && open.length) {
    return { statusCode: 409, body: JSON.stringify({ error: 'This group already has an open renewal cycle.' }) };
  }

  let cycle;
  try {
    cycle = await createRenewalCycle(group, months);
  } catch (e) {
    console.error('Open renewal error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not open the renewal cycle.' }) };
  }

  // Email every member their renewal share.
  const { data: members } = await supabase
    .from('members')
    .select('first_name, email')
    .eq('group_id', groupId);

  const bankName = process.env.WEPAY_BANK_NAME || 'WePay Collections (set WEPAY_BANK_NAME)';
  const bankAccount = process.env.WEPAY_ACCOUNT_NUMBER || '0000000000';
  const bankAccountName = process.env.WEPAY_ACCOUNT_NAME || 'WePay';
  const dashUrl = `${process.env.SITE_URL || ''}/group.html?code=${group.code}`;

  const emailFor = (firstName, toEmail) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0b1020;padding:32px;border-radius:14px;color:#e8ecf6;">
      <div style="text-align:center;margin-bottom:20px;font-size:22px;font-weight:800;color:#fff;">WePay</div>
      <h1 style="font-size:22px;color:#fff;margin:0 0 8px;">Time to renew ${group.name}, ${firstName}</h1>
      <p style="color:#9aa6c4;font-size:14px;line-height:1.7;">
        Your group's Starlink is up for renewal (${PLANS[months].label}). The dish is already set up,
        so this only covers the subscription — much cheaper than the first time.
      </p>
      <div style="background:#141a2e;border:1px solid #233056;border-radius:12px;padding:20px;margin-top:16px;">
        <p style="margin:0 0 6px;color:#9aa6c4;font-size:13px;">Your renewal share</p>
        <p style="margin:0 0 16px;color:#34d399;font-size:28px;font-weight:800;">${naira(cycle.perPay)}</p>
        <p style="margin:0 0 8px;color:#9aa6c4;font-size:13px;">Pay into:</p>
        <p style="margin:0;color:#fff;font-size:15px;line-height:1.8;">${bankName}<br/><strong>${bankAccount}</strong><br/>${bankAccountName}</p>
        <p style="margin:16px 0 0;color:#9aa6c4;font-size:12px;line-height:1.6;">Use your email <strong style="color:#fff;">${toEmail}</strong> as the transfer reference.</p>
      </div>
      <p style="color:#9aa6c4;font-size:14px;margin-top:16px;">Track your group: <a href="${dashUrl}" style="color:#22d3ee;">${dashUrl}</a></p>
      <p style="text-align:center;font-size:12px;margin-top:24px;color:#6b7596;">WePay · Affordable internet, together.</p>
    </div>`;

  try {
    await Promise.all(
      (members || []).map((m) =>
        transporter.sendMail({
          from: `"WePay" <${process.env.GMAIL_USER}>`,
          to: m.email,
          subject: `Renew ${group.name} on WePay — your share is ${naira(cycle.perPay)}`,
          html: emailFor(m.first_name, m.email),
        })
      )
    );
  } catch (emailErr) {
    console.error('Renewal email error:', emailErr);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, renewalId: cycle.renewal.id, perPerson: cycle.perPay, members: cycle.count }),
  };
};
