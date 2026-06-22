const nodemailer = require('nodemailer');
const { getSupabase, PLANS, GROUP_SIZES, quote, payable, generateCode, generateManageToken } = require('./config');

const supabase = getSupabase();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');

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

  const { groupName, venue, state, firstName, lastName, email, phone, plan, groupSize } = body;

  if (!groupName || !firstName || !lastName || !email || !plan || !groupSize) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Group name, your name, email, plan and group size are required.' }),
    };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email address.' }) };
  }

  const months = Number(plan);
  if (!PLANS[months]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown plan selected.' }) };
  }

  const size = Number(groupSize);
  if (!GROUP_SIZES.includes(size)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid group size.' }) };
  }

  const cleanEmail = email.toLowerCase().trim();
  const q = quote(months, size);

  // Create the group, retrying if the random code collides.
  const manageToken = generateManageToken();
  let group = null;
  for (let attempt = 0; attempt < 5 && !group; attempt++) {
    const code = generateCode();
    const { data, error } = await supabase
      .from('groups')
      .insert([
        {
          code,
          name: groupName,
          venue: venue || null,
          state: state || null,
          plan_months: months,
          target_size: size,
          per_person: q.perPerson,
          total_cost: q.total,
          champion_name: `${firstName} ${lastName}`,
          champion_email: cleanEmail,
          champion_phone: phone || null,
          status: 'forming',
          manage_token: manageToken,
        },
      ])
      .select()
      .single();

    if (!error) {
      group = data;
    } else if (error.code !== '23505') {
      console.error('Create group error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not create the group. Please try again.' }) };
    }
  }

  if (!group) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate a unique code. Please try again.' }) };
  }

  // Add the champion as the first member.
  const { error: memberErr } = await supabase.from('members').insert([
    {
      group_id: group.id,
      first_name: firstName,
      last_name: lastName,
      email: cleanEmail,
      phone: phone || null,
      amount: payable(group.per_person),
      is_champion: true,
      payment_status: 'pending',
    },
  ]);

  if (memberErr) {
    console.error('Champion insert error:', memberErr);
    // Group exists; let the champion proceed even if their own member row failed.
  }

  const siteUrl = process.env.SITE_URL || '';
  const joinUrl = `${siteUrl}/join.html?code=${group.code}`;
  const dashUrl = `${siteUrl}/group.html?code=${group.code}`;
  const manageUrl = `${dashUrl}&manage=${manageToken}`;
  const adminEmails = (process.env.ADMIN_NOTIFY_EMAILS || 'radicaloniszn@gmail.com').split(',').map((e) => e.trim());

  const championHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0b1020;padding:32px;border-radius:14px;color:#e8ecf6;">
      <div style="text-align:center;margin-bottom:24px;font-size:22px;font-weight:800;color:#fff;">WePay</div>
      <h1 style="font-size:22px;color:#fff;margin:0 0 8px;">Your group is live, ${firstName}!</h1>
      <p style="color:#9aa6c4;font-size:14px;line-height:1.7;">
        You started <strong style="color:#fff;">${groupName}</strong> on the
        <strong style="color:#fff;">${PLANS[months].label}</strong> plan for up to ${size} people.
        Share your invite code so your hostel-mates can join.
      </p>
      <div style="background:#141a2e;border:1px solid #233056;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
        <p style="margin:0 0 6px;color:#9aa6c4;font-size:13px;">Your invite code</p>
        <p style="margin:0;color:#22d3ee;font-size:32px;font-weight:800;letter-spacing:4px;">${group.code}</p>
      </div>
      <p style="color:#9aa6c4;font-size:14px;">Join link: <a href="${joinUrl}" style="color:#22d3ee;">${joinUrl}</a></p>
      <p style="color:#9aa6c4;font-size:14px;">Track your group: <a href="${dashUrl}" style="color:#22d3ee;">${dashUrl}</a></p>
      <div style="background:#141a2e;border:1px solid #233056;border-radius:12px;padding:16px;margin:16px 0;">
        <p style="margin:0 0 6px;color:#fbbf24;font-size:13px;font-weight:700;">Your private manage link — keep it secret</p>
        <p style="margin:0 0 8px;color:#9aa6c4;font-size:13px;line-height:1.6;">As the champion, this link lets you remove members who joined but never paid, so they don't hold up your group. Don't share it.</p>
        <a href="${manageUrl}" style="color:#22d3ee;font-size:13px;word-break:break-all;">${manageUrl}</a>
      </div>
      <p style="color:#9aa6c4;font-size:14px;margin-top:16px;">Each person's share: <strong style="color:#34d399;">${naira(group.per_person)}</strong></p>
      <p style="text-align:center;font-size:12px;margin-top:24px;color:#6b7596;">WePay · Affordable internet, together.</p>
    </div>`;

  const adminHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;">New WePay group created</h2>
      <p style="margin:0 0 4px;">${groupName} ${venue ? '· ' + venue : ''} ${state ? '· ' + state : ''}</p>
      <p style="margin:0 0 4px;">Code: <strong>${group.code}</strong> · ${PLANS[months].label} · up to ${size} · share ${naira(group.per_person)}</p>
      <p style="margin:0;">Champion: ${firstName} ${lastName} &lt;${cleanEmail}&gt; ${phone || ''}</p>
    </div>`;

  try {
    await Promise.all([
      transporter.sendMail({
        from: `"WePay" <${process.env.GMAIL_USER}>`,
        to: cleanEmail,
        subject: `Your WePay group "${groupName}" is live — code ${group.code}`,
        html: championHtml,
      }),
      transporter.sendMail({
        from: `"WePay" <${process.env.GMAIL_USER}>`,
        to: adminEmails.join(', '),
        subject: `New WePay group: ${groupName} (${group.code})`,
        html: adminHtml,
      }),
    ]);
  } catch (emailErr) {
    console.error('Email error:', emailErr);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      code: group.code,
      groupName: group.name,
      plan: PLANS[months].label,
      amount: group.per_person,
      targetSize: group.target_size,
      joinUrl,
      dashUrl,
      manageUrl,
    }),
  };
};
