const { getSupabase } = require('./config');

const supabase = getSupabase();

exports.handler = async (event) => {
  const password = event.headers['x-admin-password'];
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { data: groups, error } = await supabase
    .from('groups')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Groups error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not fetch groups.' }) };
  }

  const { data: members, error: memErr } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, phone, amount, is_champion, payment_status, group_id, created_at')
    .order('created_at', { ascending: true });

  if (memErr) {
    console.error('Members error:', memErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not fetch members.' }) };
  }

  const byGroup = {};
  for (const m of members) {
    (byGroup[m.group_id] = byGroup[m.group_id] || []).push(m);
  }
  const memberById = {};
  for (const m of members) memberById[m.id] = m;

  // Renewal cycles + their per-member payments (newest cycle per group).
  const { data: renewals } = await supabase
    .from('renewals')
    .select('*')
    .order('created_at', { ascending: false });
  const { data: renewalPayments } = await supabase
    .from('renewal_payments')
    .select('*');

  const latestRenewalByGroup = {};
  for (const r of renewals || []) {
    if (!latestRenewalByGroup[r.group_id]) latestRenewalByGroup[r.group_id] = r;
  }
  const paymentsByRenewal = {};
  for (const p of renewalPayments || []) {
    (paymentsByRenewal[p.renewal_id] = paymentsByRenewal[p.renewal_id] || []).push(p);
  }

  const result = groups.map((g) => {
    const list = byGroup[g.id] || [];
    const r = latestRenewalByGroup[g.id];
    let renewal = null;
    if (r) {
      const pays = (paymentsByRenewal[r.id] || []).map((p) => {
        const mem = memberById[p.member_id];
        return {
          id: p.id,
          name: mem ? `${mem.first_name} ${mem.last_name}` : 'Member',
          email: mem ? mem.email : '',
          amount: p.amount,
          payment_status: p.payment_status,
        };
      });
      renewal = {
        id: r.id,
        months: r.months,
        per_person: r.per_person,
        status: r.status,
        payments: pays,
        paidCount: pays.filter((p) => p.payment_status === 'confirmed').length,
        total: pays.length,
      };
    }
    return {
      ...g,
      members: list,
      memberCount: list.length,
      paidCount: list.filter((m) => m.payment_status === 'confirmed').length,
      renewal,
    };
  });

  return { statusCode: 200, body: JSON.stringify({ groups: result }) };
};
