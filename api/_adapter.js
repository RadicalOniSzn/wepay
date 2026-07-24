// Adapts a Netlify-style handler (event => { statusCode, body }) to a Vercel
// (req, res) serverless function, so the battle-tested code in
// netlify/functions/ runs on Vercel unchanged. Files prefixed with "_" in
// /api are helpers, not endpoints.
module.exports = function adapt(handler) {
  return async (req, res) => {
    const event = {
      httpMethod: req.method,
      headers: req.headers || {},
      queryStringParameters: req.query || {},
      // Netlify hands the raw body string; Vercel pre-parses JSON bodies.
      body: typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : null,
    };
    try {
      const result = await handler(event);
      res.status((result && result.statusCode) || 200);
      res.setHeader('Content-Type', 'application/json');
      res.send((result && result.body) || '{}');
    } catch (err) {
      console.error('Function error:', err);
      res.status(500);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'Internal error' }));
    }
  };
};
