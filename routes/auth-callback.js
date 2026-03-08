// routes/auth-callback.js — OAuth callback para token de usuário ML
// Redirect URI cadastrado no ML: https://dexan-chat-backend-production.up.railway.app/api/oauth/callback

const REDIRECT_URI = 'https://dexan-chat-backend-production.up.railway.app/api/oauth/callback';

export async function handleAuthCallback(req, res) {
  const { code, error } = req.query;

  if (error) return res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px">
    <h2>❌ Erro do ML: ${error}</h2>
    <p>O ML retornou um erro ao tentar autorizar o aplicativo.</p>
  </body></html>`);

  if (!code) return res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px">
    <h2>❌ Sem código de autorização</h2>
    <p>Acesse a <a href="/api/oauth/authorize">URL de autorização</a> primeiro.</p>
  </body></html>`);

  const clientId     = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;

  try {
    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        redirect_uri:  REDIRECT_URI
      }).toString()
    });
    const data = await resp.json();

    if (!data.access_token) {
      return res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px">
        <h2>❌ Falha ao obter token</h2>
        <pre style="background:#f1f5f9;padding:16px;border-radius:8px">${JSON.stringify(data, null, 2)}</pre>
      </body></html>`);
    }

    // Salvar token em memória global (válido até o próximo deploy)
    global._mlUserToken        = data.access_token;
    global._mlUserTokenExpiry  = Date.now() + (data.expires_in - 300) * 1000;
    global._mlUserRefreshToken = data.refresh_token;

    console.log('✅ Token OAuth de usuário obtido! User ID:', data.user_id);

    return res.status(200).send(`
      <html>
      <head><title>DEXAN — OAuth OK</title></head>
      <body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto;background:#0F172A;color:#F1F5F9">
        <h1 style="color:#10B981">✅ Autorização concluída!</h1>
        <p>User ID ML: <strong>${data.user_id}</strong></p>
        <p>Token válido por: <strong>${Math.round(data.expires_in/3600)} horas</strong></p>
        <p style="margin-top:24px;padding:16px;background:#1E293B;border-radius:8px;color:#94A3B8;font-size:.85rem">
          Token salvo em memória no servidor. O Radar v8 agora usará este token para buscas reais via /sites/MLB/search.
        </p>
        <p style="margin-top:24px">
          <a href="https://roadmap.dexancommerce.com/radar-dexan-v8" 
             style="background:#F97316;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
            🎯 Ir para o DEXAN Radar v8
          </a>
        </p>
      </body></html>`);

  } catch (err) {
    console.error('OAuth callback error:', err.message);
    return res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px">
      <h2>❌ Erro interno: ${err.message}</h2>
    </body></html>`);
  }
}
