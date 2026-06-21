const { getSupabase, termDates, deadlineFor } = require('./config');

const supabase = getSupabase();

const VALID = ['forming', 'full', 'funded', 'active', 'lapsed', 'cancelled'];

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

  const { groupId, status, starlinkRenewsOn } = body;
  if (!groupId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'groupId is required.' }) };
  }
  if (status !== undefined && !VALID.includes(status)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid status.' }) };
  }
  if (status === undefined && starlinkRenewsOn === undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to update.' }) };
  }

  const update = {};
  if (status !== undefined) update.status = status;

  // Manual correction of the real Starlink billing date. The member
  // deadline (expires_at) is always kept the grace buffer ahead of it.
  if (starlinkRenewsOn !== undefined) {
    const renewsOn = new Date(starlinkRenewsOn);
    if (isNaN(renewsOn.getTime())) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Starlink billing date.' }) };
    }
    update.starlink_renews_on = renewsOn.toISOString();
    update.expires_at = deadlineFor(renewsOn).toISOString();
  }

  // First time a group goes 'active' the subscription clock starts:
  // record the activation date, the real Starlink billing date
  // (activation + plan_months) and the member deadline (billing - grace).
  // Don't reset it if it's already set.
  if (status === 'active') {
    const { data: group } = await supabase
      .from('groups')
      .select('plan_months, activated_at')
      .eq('id', groupId)
      .single();
    if (group && !group.activated_at) {
      const now = new Date();
      const { renewsOn, deadline } = termDates(now, group.plan_months);
      update.activated_at = now.toISOString();
      update.starlink_renews_on = renewsOn.toISOString();
      update.expires_at = deadline.toISOString();
    }
  }

  const { error } = await supabase.from('groups').update(update).eq('id', groupId);
  if (error) {
    console.error('Update group error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not update group.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
