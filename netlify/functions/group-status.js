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

  const { data: members } = await supabase
    .from('members')
    .select('first_name, last_name, is_champion, payment_status, created_at')
    .eq('group_id', group.id)
    .order('created_at', { ascending: true });

  const list = members || [];
  const paid = list.filter((m) => m.payment_status === 'confirmed').length;

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
      },
      members: list.map((m) => ({
        name: `${m.first_name} ${m.last_name.charAt(0)}.`,
        isChampion: m.is_champion,
        paymentStatus: m.payment_status,
      })),
      bank: bankName ? { name: bankName, account: bankAccount, accountName: bankAccountName } : null,
    }),
  };
};
