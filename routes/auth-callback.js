// routes/auth-callback.js — salva token OAuth em memória E em arquivo persistente
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI     = 'https://dexan-chat-backend-production.up.railway.app/api/oauth/callback';
const TOKEN_FILE       = '/tmp/ml_token.json';

// ─── Carrega token salvo em disco ao iniciar ──────────────────────────────────
export function loadSavedToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      if (saved.token && saved.expiry && Date.now() < saved.expiry) {
        global._mlUserToken       = saved.token;
        global._mlUserTokenExpiry = saved.expiry;
        global._mlUserId          = saved.userId;
        console.log(`✅ Token ML restaurado do disco — user ${saved.userId}, válido por ${Math.round((saved.expiry - Date.now())/60000)} min`);
        return true;
      } else {
        console.log('⚠️ Token salvo expirado, aguardando nova autorização');
      }
    }
  } catch(e) {
    console.log('Erro ao carregar token salvo:', e.message);
  }
  return false;
}

export async function handleOAuthCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<h2>❌ Erro: ${error}</h2>`);
  }

  if (!code) {
    return res.redirect('/api/oauth/authorize');
  }

  try {
    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri:  REDIRECT_URI,
      }).toString()
    });

    const data = await resp.json();

    if (!resp.ok || !data.access_token) {
      console.error('Erro OAuth:', data);
      return res.send(`<h2>❌ Erro ao trocar code por token</h2><pre>${JSON.stringify(data,null,2)}</pre>`);
    }

    const expiryMs = Date.now() + (data.expires_in - 300) * 1000;

    // Salvar em memória
    global._mlUserToken       = data.access_token;
    global._mlUserTokenExpiry = expiryMs;
    global._mlUserId          = data.user_id;

    // Salvar em disco para sobreviver restarts
    writeFileSync(TOKEN_FILE, JSON.stringify({
      token:  data.access_token,
      expiry: expiryMs,
      userId: data.user_id,
      savedAt: new Date().toISOString()
    }));

    const horasValido = Math.round(data.expires_in / 3600);
    console.log(`✅ Token OAuth salvo — user ${data.user_id}, válido ${horasValido}h`);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>DEXAN — Autorizado!</title>
        <style>
          body { font-family: sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#f0f4ff; }
          .card { background:white; border-radius:16px; padding:40px; text-align:center; box-shadow:0 4px 24px rgba(0,0,0,0.1); max-width:400px; }
          .icon { font-size:64px; }
          h2 { color:#1E40AF; }
          p { color:#666; }
          a { display:inline-block; margin-top:20px; padding:12px 32px; background:linear-gradient(135deg,#1E40AF,#F97316); color:white; border-radius:8px; text-decoration:none; font-weight:bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✅</div>
          <h2>Autorização concluída!</h2>
          <p>User ID ML: ${data.user_id}</p>
          <p>Token válido por: ${horasValido} horas</p>
          <p>Token salvo em memória no servidor.<br>O Radar v8 agora usará este token para buscas reais via /sites/MLB/search.</p>
          <a href="https://roadmap.dexancommerce.com/radar-dexan-v8">🎯 Ir para o DEXAN Radar v8</a>
        </div>
      </body>
      </html>
    `);
  } catch(err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`<h2>❌ Erro interno: ${err.message}</h2>`);
  }
}

export async function handleOAuthAuthorize(req, res) {
  const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>DEXAN — Autorizar ML</title>
      <style>
        body { font-family:sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#f0f4ff; }
        .card { background:white; border-radius:16px; padding:40px; text-align:center; box-shadow:0 4px 24px rgba(0,0,0,0.1); max-width:400px; }
        a { display:inline-block; margin-top:20px; padding:14px 36px; background:linear-gradient(135deg,#1E40AF,#F97316); color:white; border-radius:8px; text-decoration:none; font-weight:bold; font-size:16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🔑 Autorizar conta ML</h2>
        <p>Clique abaixo para conectar a conta do Mercado Livre ao DEXAN Radar.</p>
        <a href="${authUrl}">Conectar conta Mercado Livre</a>
      </div>
    </body>
    </html>
  `);
}
