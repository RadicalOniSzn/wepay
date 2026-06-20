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

  const { password } = body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Invalid password' }) };
};
