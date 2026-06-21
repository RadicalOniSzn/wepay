const { getSupabase, deadlineFor } = require('./config');

const supabase = getSupabase();

// Admin applies a renewal cycle once everyone has paid: marks it applied
// and extends the group's Starlink billing date by the renewal term. The
// new billing date is built from the later of the current billing date or
// now, so paying early doesn't lose time and renewing late doesn't
// backdate. The member deadline (expires_at) is kept the grace buffer
// ahead of it, and a lapsed group is revived back to 'active'.
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
    .select('starlink_renews_on')
    .eq('id', renewal.group_id)
    .single();

  const now = new Date();
  const current = group && group.starlink_renews_on ? new Date(group.starlink_renews_on) : now;
  const base = current > now ? current : now;
  const newRenewsOn = new Date(base);
  newRenewsOn.setMonth(newRenewsOn.getMonth() + Number(renewal.months || 0));
  const newDeadline = deadlineFor(newRenewsOn);

  const { error: gUpdErr } = await supabase
    .from('groups')
    .update({
      status: 'active', // revive a lapsed group that paid late
      starlink_renews_on: newRenewsOn.toISOString(),
      expires_at: newDeadline.toISOString(),
      renewal_reminded_at: null,
      lapsed_at: null,
    })
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

  return { statusCode: 200, body: JSON.stringify({ ok: true, starlinkRenewsOn: newRenewsOn.toISOString(), expiresAt: newDeadline.toISOString() }) };
};
