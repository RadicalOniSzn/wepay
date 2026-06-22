const { getSupabase, PLANS, payable } = require('./config');

const supabase = getSupabase();

// Public lookup by invite code. Returns group progress + member list
// (names + payment status) so the champion and members can track it.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) };
  }

  const code = (body.code || '').toUpperCase().trim();
  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invite code is required.' }) };
  }

  const { data: group, error } = await supabase.from('groups').select('*').eq('code', code).single();
  if (error || !group) {
    return { statusCode: 404, body: JSON.stringify({ error: 'No group found with that code.' }) };
  }

  // Champion management: a matching manage token unlocks the Remove buttons and
  // exposes member IDs + full names. Never leak the token itself back out.
  const canManage = !!(body.manage && group.manage_token && body.manage === group.manage_token);

  const { data: members } = await supabase
    .from('members')
    .select('id, first_name, last_name, is_champion, payment_status, created_at')
    .eq('group_id', group.id)
    .order('created_at', { ascending: true });

  const list = members || [];
  const paid = list.filter((m) => m.payment_status === 'confirmed').length;

  // Open renewal cycle (if any) — lets members see their renewal share.
  const { data: openRenewals } = await supabase
    .from('renewals')
    .select('*')
    .eq('group_id', group.id)
    .eq('status', 'collecting')
    .order('created_at', { ascending: false })
    .limit(1);
  const openRenewal = openRenewals && openRenewals.length ? openRenewals[0] : null;

  let renewal = null;
  const renewalStatusByMember = {};
  if (openRenewal) {
    const { data: pays } = await supabase
      .from('renewal_payments')
      .select('member_id, amount, payment_status')
      .eq('renewal_id', openRenewal.id);
    const payList = pays || [];
    payList.forEach((p) => { renewalStatusByMember[p.member_id] = p.payment_status; });
    renewal = {
      open: true,
      months: openRenewal.months,
      planLabel: PLANS[openRenewal.months] ? PLANS[openRenewal.months].label : openRenewal.months + ' Months',
      payable: payList.length ? payList[0].amount : null,
      paid: payList.filter((p) => p.payment_status === 'confirmed').length,
      total: payList.length,
      payBy: group.expires_at || null, // member deadline (before Starlink bills)
    };
  }

  // The member-facing "renews on" is the real Starlink billing date.
  const renewsOn = group.starlink_renews_on || group.expires_at || null;

  const bankName = process.env.WEPAY_BANK_NAME || null;
  const bankAccount = process.env.WEPAY_ACCOUNT_NUMBER || null;
  const bankAccountName = process.env.WEPAY_ACCOUNT_NAME || null;

  return {
    statusCode: 200,
    body: JSON.stringify({
      group: {
        code: group.code,
        name: group.name,
        venue: group.venue,
        state: group.state,
        planMonths: group.plan_months,
        planLabel: PLANS[group.plan_months] ? PLANS[group.plan_months].label : group.plan_months + ' Months',
        perPerson: group.per_person,
        payable: payable(group.per_person),
        targetSize: group.target_size,
        status: group.status,
        championName: group.champion_name,
        joined: list.length,
        paid,
        renewsOn,
      },
      renewal,
      canManage,
      members: list.map((m) => ({
        id: canManage ? m.id : undefined,
        name: canManage ? `${m.first_name} ${m.last_name}` : `${m.first_name} ${m.last_name.charAt(0)}.`,
        isChampion: m.is_champion,
        paymentStatus: m.payment_status,
        renewalStatus: renewalStatusByMember[m.id] || null,
      })),
      bank: bankName ? { name: bankName, account: bankAccount, accountName: bankAccountName } : null,
    }),
  };
};
