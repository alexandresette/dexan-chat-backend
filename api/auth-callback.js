// api/auth-callback.js v2 — Debug completo + auto-save do token

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`<html><body style="font-family:sans-serif;padding:50px">
      <h2>❌ Erro: ${error}</h2></body></html>`);
  }

  if (!code) {
    return res.status(400).send(`<html><body style="font-family:sans-serif;padding:50px">
      <h2>❌ Sem código</h2><p>Acesse o link de autorização novamente.</p></body></html>`);
  }

  const clientId     = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  const redirectUri  = 'https://dexan-chat-backend.vercel.app/api/auth-callback';

  try {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      code:          code,
      redirect_uri:  redirectUri
    });

    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString()
    });

    const data = await resp.json();
    
    // Log completo da resposta ML
    console.log('ML OAuth response:', JSON.stringify(data));

    if (!data.access_token) {
      return res.status(500).send(`<html><body style="font-family:sans-serif;padding:50px">
        <h2>❌ Sem access_token</h2>
        <p>Status HTTP: ${resp.status}</p>
        <pre style="background:#f1f5f9;padding:15px;border-radius:8px">${JSON.stringify(data, null, 2)}</pre>
      </body></html>`);
    }

    const accessToken  = data.access_token;
    const refreshToken = data.refresh_token || null;
    const userId       = data.user_id;
    const expiresIn    = data.expires_in;
    const allKeys      = Object.keys(data);

    // Salvar no cache global do processo (dura enquanto o serverless estiver quente)
    global.mlTokenCache = {
      token: accessToken,
      refresh: refreshToken,
      expiresAt: Date.now() + (expiresIn * 1000)
    };

    // Testar busca ML com esse token
    const testResp = await fetch(
      'https://api.mercadolibre.com/sites/MLB/search?q=colete+de+peso&limit=3',
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } }
    );
    const testData  = await testResp.json();
    const buscaOk   = Array.isArray(testData.results) && testData.results.length > 0;
    const totalML   = testData.paging?.total || 0;
    const testError = testData.message || testData.error || '';

    return res.status(200).send(`
      <html>
      <head><meta charset="utf-8">
      <style>
        body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px}
        .ok{background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:16px;margin:12px 0}
        .warn{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:16px;margin:12px 0}
        .err{background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:16px;margin:12px 0}
        code{background:#f1f5f9;padding:3px 7px;border-radius:4px;font-size:12px;word-break:break-all;display:block;margin-top:8px}
        h1{color:#1e40af}
      </style>
      </head>
      <body>
        <h1>🎉 DEXAN Garimpador — Diagnóstico OAuth</h1>

        <div class="ok">
          <strong>✅ Token obtido com sucesso!</strong><br>
          User ID: ${userId} | Expira: ${Math.round(expiresIn/3600)}h<br>
          Campos retornados pelo ML: <strong>${allKeys.join(', ')}</strong>
        </div>

        ${buscaOk ? `
        <div class="ok">
          <strong>✅ BUSCA ML FUNCIONANDO!</strong><br>
          "colete de peso" → ${totalML} produtos encontrados 🎯
        </div>` : `
        <div class="err">
          <strong>❌ Busca ainda com erro: ${testError}</strong><br>
          HTTP status da busca: ${testResp.status}
        </div>`}

        <div class="${refreshToken ? 'ok' : 'warn'}">
          <strong>${refreshToken ? '✅' : '⚠️'} Refresh Token:</strong>
          <code>${refreshToken || 'NÃO RETORNADO — app precisa de certificação ML para receber refresh_token'}</code>
        </div>

        <div class="warn">
          <strong>⚠️ ACCESS TOKEN (válido por 6h) — copie e envie para o Claude:</strong>
          <code>${accessToken}</code>
        </div>

        <div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:12px 0;font-size:12px">
          <strong>Resposta completa do ML:</strong>
          <pre>${JSON.stringify(data, null, 2)}</pre>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    return res.status(500).send(`<html><body style="font-family:sans-serif;padding:50px">
      <h2>❌ Erro interno: ${err.message}</h2></body></html>`);
  }
}
