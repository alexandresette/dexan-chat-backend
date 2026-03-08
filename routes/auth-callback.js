export async function handleAuthCallback(req, res) {
  const { code, error } = req.query;

  if (error) return res.status(400).send(`<html><body><h2>❌ Erro: ${error}</h2></body></html>`);
  if (!code) return res.status(400).send(`<html><body><h2>❌ Sem código</h2></body></html>`);

  const clientId     = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  // Atualizado para Railway após migração
  const redirectUri  = process.env.RAILWAY_URL
    ? `${process.env.RAILWAY_URL}/api/auth-callback`
    : 'https://dexan-chat-backend.vercel.app/api/auth-callback';

  try {
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString()
    });
    const data = await resp.json();
    if (!data.access_token) return res.status(500).send(`<pre>${JSON.stringify(data,null,2)}</pre>`);

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
        <h1>✅ Token Obtido!</h1>
        <p>User ID: ${data.user_id} | Expira em: ${Math.round(data.expires_in/3600)}h</p>
        <p><strong>Access Token:</strong></p>
        <code style="word-break:break-all;background:#f1f5f9;padding:10px;display:block">${data.access_token}</code>
      </body></html>`);
  } catch (err) {
    return res.status(500).send(`<h2>Erro: ${err.message}</h2>`);
  }
}
