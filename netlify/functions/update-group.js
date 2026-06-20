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

  const { error } = await supabase.from('groups').update({ status }).eq('id', groupId);
  if (error) {
    console.error('Update group error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not update group.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
