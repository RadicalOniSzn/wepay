const { getSupabase } = require('./config');

const supabase = getSupabase();

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

  const { memberId, status } = body;
  if (!memberId || !['pending', 'confirmed'].includes(status)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'memberId and a valid status are required.' }) };
  }

  const { error } = await supabase
    .from('members')
    .update({ payment_status: status, paid_at: status === 'confirmed' ? new Date().toISOString() : null })
    .eq('id', memberId);

  if (error) {
    console.error('Mark paid error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not update payment.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
