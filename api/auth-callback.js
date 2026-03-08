// api/auth-callback.js — Recebe o ?code do ML OAuth e troca pelo token
// Salva o refresh_token como variável de ambiente via Vercel API

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>❌ Erro na autorização</h2>
        <p>${error}</p>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>❌ Código não encontrado</h2>
        <p>Acesse o link de autorização novamente.</p>
      </body></html>
    `);
  }

  const clientId     = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  const redirectUri  = 'https://dexan-chat-backend.vercel.app/api/auth-callback';

  try {
    // Trocar code pelo access_token
    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     clientId,
        client_secret: clientSecret,
        code:          code,
        redirect_uri:  redirectUri
      })
    });

    const data = await resp.json();

    if (!data.access_token) {
      return res.status(500).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:50px">
          <h2>❌ Erro ao obter token</h2>
          <pre>${JSON.stringify(data, null, 2)}</pre>
        </body></html>
      `);
    }

    // Salvar tokens em memória (env vars precisam ser configuradas manualmente no Vercel)
    // Exibir os tokens para o usuário copiar
    const accessToken  = data.access_token;
    const refreshToken = data.refresh_token;
    const userId       = data.user_id;
    const expiresIn    = data.expires_in;

    // Testar se a busca funciona com esse token
    const testResp = await fetch(
      'https://api.mercadolibre.com/sites/MLB/search?q=colete+de+peso&limit=3',
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } }
    );
    const testData = await testResp.json();
    const buscaOk  = testData.results?.length > 0;
    const totalML  = testData.paging?.total || 0;

    return res.status(200).send(`
      <html>
      <head><meta charset="utf-8">
      <style>
        body{font-family:sans-serif;max-width:700px;margin:50px auto;padding:20px}
        .ok{background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:20px;margin:20px 0}
        .warn{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:20px;margin:20px 0}
        code{background:#f1f5f9;padding:4px 8px;border-radius:4px;font-size:13px;word-break:break-all}
        h1{color:#1e40af}
      </style>
      </head>
      <body>
        <h1>🎉 DEXAN Garimpador autorizado!</h1>
        
        <div class="ok">
          <strong>✅ Autorização bem-sucedida!</strong><br>
          User ID: ${userId} | Token expira em: ${Math.round(expiresIn/3600)}h
        </div>

        ${buscaOk ? `
        <div class="ok">
          <strong>✅ Busca ML funcionando!</strong><br>
          Teste "colete de peso" retornou ${totalML} produtos — API 100% operacional.
        </div>` : `
        <div class="warn">
          <strong>⚠️ Busca ML ainda não funcionando</strong><br>
          Token obtido mas a busca retornou erro. Verifique as env vars.
        </div>`}

        <div class="warn">
          <strong>⚠️ Copie o Refresh Token abaixo e envie para o Claude:</strong><br><br>
          <strong>REFRESH_TOKEN:</strong><br>
          <code>${refreshToken}</code><br><br>
          <strong>ACCESS_TOKEN (6h):</strong><br>
          <code>${accessToken.substring(0, 60)}...</code>
        </div>

        <p>Após copiar o refresh token, feche esta página. O Claude vai salvá-lo no Vercel.</p>
      </body>
      </html>
    `);

  } catch (err) {
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>❌ Erro interno</h2>
        <p>${err.message}</p>
      </body></html>
    `);
  }
}
