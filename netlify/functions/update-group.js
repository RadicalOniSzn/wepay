const { getSupabase } = require('./config');

const supabase = getSupabase();

const VALID = ['forming', 'full', 'funded', 'active', 'cancelled'];

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

  const { groupId, status } = body;
  if (!groupId || !VALID.includes(status)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'groupId and a valid status are required.' }) };
  }

  const update = { status };

  // First time a group goes 'active' the subscription clock starts:
  // record the activation date and when the current term expires
  // (activation + plan_months). Don't reset it if it's already set.
  if (status === 'active') {
    const { data: group } = await supabase
      .from('groups')
      .select('plan_months, activated_at')
      .eq('id', groupId)
      .single();
    if (group && !group.activated_at) {
      const now = new Date();
      const expires = new Date(now);
      expires.setMonth(expires.getMonth() + Number(group.plan_months || 0));
      update.activated_at = now.toISOString();
      update.expires_at = expires.toISOString();
    }
  }

  const { error } = await supabase.from('groups').update(update).eq('id', groupId);
  if (error) {
    console.error('Update group error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not update group.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
