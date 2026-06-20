const { getSupabase } = require('./config');

const supabase = getSupabase();

// Admin applies a renewal cycle once everyone has paid: marks it applied
// and extends the group's expiry by the renewal term. New expiry is built
// from the later of the current expiry or now, so paying early doesn't
// lose time and renewing late doesn't backdate.
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

  const { renewalId } = body;
  if (!renewalId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'renewalId is required.' }) };
  }

  const { data: renewal, error: rErr } = await supabase
    .from('renewals')
    .select('*')
    .eq('id', renewalId)
    .single();
  if (rErr || !renewal) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Renewal cycle not found.' }) };
  }
  if (renewal.status === 'applied') {
    return { statusCode: 409, body: JSON.stringify({ error: 'This renewal has already been applied.' }) };
  }

  const { data: group } = await supabase
    .from('groups')
    .select('expires_at')
    .eq('id', renewal.group_id)
    .single();

  const now = new Date();
  const current = group && group.expires_at ? new Date(group.expires_at) : now;
  const base = current > now ? current : now;
  const newExpiry = new Date(base);
  newExpiry.setMonth(newExpiry.getMonth() + Number(renewal.months || 0));

  const { error: gUpdErr } = await supabase
    .from('groups')
    .update({ expires_at: newExpiry.toISOString(), renewal_reminded_at: null })
    .eq('id', renewal.group_id);
  if (gUpdErr) {
    console.error('Apply renewal (group) error:', gUpdErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not extend the group.' }) };
  }

  const { error: rUpdErr } = await supabase
    .from('renewals')
    .update({ status: 'applied', applied_at: now.toISOString() })
    .eq('id', renewalId);
  if (rUpdErr) {
    console.error('Apply renewal (renewal) error:', rUpdErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Group extended but could not close the cycle.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, expiresAt: newExpiry.toISOString() }) };
};
