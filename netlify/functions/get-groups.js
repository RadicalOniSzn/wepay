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

  const result = groups.map((g) => {
    const list = byGroup[g.id] || [];
    return {
      ...g,
      members: list,
      memberCount: list.length,
      paidCount: list.filter((m) => m.payment_status === 'confirmed').length,
    };
  });

  return { statusCode: 200, body: JSON.stringify({ groups: result }) };
};
