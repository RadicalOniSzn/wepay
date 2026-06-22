const { getSupabase } = require('./config');

const supabase = getSupabase();

// Remove a member who joined but never paid, so abandoners don't hold up a
// group by occupying slots. Authorized EITHER by the admin password header OR
// by the group's secret manage_token (the champion's private link).
// Only PENDING, non-champion members can be removed. Hard delete — the row is
// gone and any renewal_payments cascade with it.
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

  const { memberId, manageToken } = body;
  if (!memberId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'memberId is required.' }) };
  }

  // Load the member + their group so we can check permissions and protections.
  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('id, group_id, is_champion, payment_status')
    .eq('id', memberId)
    .single();

  if (memberErr || !member) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Member not found.' }) };
  }

  // Authorize: admin password OR the group's manage token.
  const password = event.headers['x-admin-password'];
  const isAdmin = password && password === process.env.ADMIN_PASSWORD;

  let isChampion = false;
  if (!isAdmin && manageToken) {
    const { data: group } = await supabase
      .from('groups')
      .select('manage_token')
      .eq('id', member.group_id)
      .single();
    isChampion = !!(group && group.manage_token && group.manage_token === manageToken);
  }

  if (!isAdmin && !isChampion) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Protections: never remove the champion or anyone who has paid.
  if (member.is_champion) {
    return { statusCode: 400, body: JSON.stringify({ error: 'The champion cannot be removed.' }) };
  }
  if (member.payment_status === 'confirmed') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Paid members cannot be removed.' }) };
  }

  const { error: delErr } = await supabase.from('members').delete().eq('id', memberId);
  if (delErr) {
    console.error('Remove member error:', delErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not remove the member.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
