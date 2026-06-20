const { getSupabase } = require('./config');

const supabase = getSupabase();

// Admin confirms / un-confirms a single member's renewal payment.
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

  const { paymentId, status } = body;
  if (!paymentId || !['pending', 'confirmed'].includes(status)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'paymentId and a valid status are required.' }) };
  }

  const { error } = await supabase
    .from('renewal_payments')
    .update({ payment_status: status, paid_at: status === 'confirmed' ? new Date().toISOString() : null })
    .eq('id', paymentId);

  if (error) {
    console.error('Mark renewal paid error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not update renewal payment.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
