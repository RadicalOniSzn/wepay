const nodemailer = require('nodemailer');
const { getSupabase, PLANS, payable } = require('./config');

const supabase = getSupabase();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');

async function countMembers(groupId) {
  const { count } = await supabase
    .from('members')
    .select('*', { count: 'exact', head: true })
    .eq('group_id', groupId);
  return count || 0;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { code, firstName, lastName, email, phone } = body;
  if (!code || !firstName || !lastName || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invite code, name and email are required.' }) };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email address.' }) };
  }

  const cleanCode = code.toUpperCase().trim();
  const cleanEmail = email.toLowerCase().trim();

  const { data: group, error: gErr } = await supabase
    .from('groups')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (gErr || !group) {
    return { statusCode: 404, body: JSON.stringify({ error: 'No group found with that code. Check the code and try again.' }) };
  }

  if (group.status === 'cancelled') {
    return { statusCode: 409, body: JSON.stringify({ error: 'This group is no longer active.' }) };
  }

  const current = await countMembers(group.id);
  if (current >= group.target_size) {
    return { statusCode: 409, body: JSON.stringify({ error: 'This group is already full.' }) };
  }

  const toPay = payable(group.per_person);

  const { error: insErr } = await supabase.from('members').insert([
    {
      group_id: group.id,
      first_name: firstName,
      last_name: lastName,
      email: cleanEmail,
      phone: phone || null,
      amount: toPay,
      is_champion: false,
      payment_status: 'pending',
    },
  ]);

  if (insErr) {
    if (insErr.code === '23505') {
      return { statusCode: 409, body: JSON.stringify({ error: 'You have already joined this group.' }) };
    }
    console.error('Join insert error:', insErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not add you to the group. Please try again.' }) };
  }

  const joined = await countMembers(group.id);
  if (joined >= group.target_size && group.status === 'forming') {
    await supabase.from('groups').update({ status: 'full' }).eq('id', group.id);
    group.status = 'full';
  }

  const bankName = process.env.WEPAY_BANK_NAME || 'WePay Collections (set WEPAY_BANK_NAME)';
  const bankAccount = process.env.WEPAY_ACCOUNT_NUMBER || '0000000000';
  const bankAccountName = process.env.WEPAY_ACCOUNT_NAME || 'WePay';

  const memberHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0b1020;padding:32px;border-radius:14px;color:#e8ecf6;">
      <div style="text-align:center;margin-bottom:20px;font-size:22px;font-weight:800;color:#fff;">WePay</div>
      <h1 style="font-size:22px;color:#fff;margin:0 0 8px;">You're in, ${firstName}!</h1>
      <p style="color:#9aa6c4;font-size:14px;line-height:1.7;">
        You joined <strong style="color:#fff;">${group.name}</strong> (${PLANS[group.plan_months].label}).
        ${joined} of ${group.target_size} people have joined.
      </p>
      <div style="background:#141a2e;border:1px solid #233056;border-radius:12px;padding:20px;margin-top:16px;">
        <p style="margin:0 0 6px;color:#9aa6c4;font-size:13px;">Your share to pay</p>
        <p style="margin:0 0 4px;color:#34d399;font-size:28px;font-weight:800;">${naira(toPay)}</p>
        <p style="margin:0 0 16px;color:#6b7596;font-size:12px;">Includes a small 3% service fee for setup &amp; management.</p>
        <p style="margin:0 0 8px;color:#9aa6c4;font-size:13px;">Pay into:</p>
        <p style="margin:0;color:#fff;font-size:15px;line-height:1.8;">${bankName}<br/><strong>${bankAccount}</strong><br/>${bankAccountName}</p>
        <p style="margin:16px 0 0;color:#9aa6c4;font-size:12px;line-height:1.6;">Use your email <strong style="color:#fff;">${cleanEmail}</strong> as the transfer reference. The group activates once everyone has paid.</p>
      </div>
      <p style="text-align:center;font-size:12px;margin-top:24px;color:#6b7596;">WePay · Affordable internet, together.</p>
    </div>`;

  try {
    await transporter.sendMail({
      from: `"WePay" <${process.env.GMAIL_USER}>`,
      to: cleanEmail,
      subject: `You joined ${group.name} on WePay — your share is ${naira(toPay)}`,
      html: memberHtml,
    });
  } catch (emailErr) {
    console.error('Email error:', emailErr);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      code: group.code,
      groupName: group.name,
      plan: PLANS[group.plan_months].label,
      amount: toPay,
      joined,
      target: group.target_size,
      status: group.status,
    }),
  };
};
