// routes/auth-callback.js — salva token em disco E em variável de ambiente Railway
import { writeFileSync, readFileSync, existsSync } from 'fs';

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI     = 'https://dexan-chat-backend-production.up.railway.app/api/oauth/callback';
const TOKEN_FILE       = '/tmp/ml_token.json';

// Carrega token salvo em disco ao iniciar
export function loadSavedToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      if (saved.token && saved.expiry && Date.now() < saved.expiry) {
        global._mlUserToken       = saved.token;
        global._mlUserTokenExpiry = saved.expiry;
        global._mlUserId          = saved.userId;
        const min = Math.round((saved.expiry - Date.now())/60000);
        console.log(`✅ Token ML restaurado do disco — user ${saved.userId}, válido por ${min} min`);
        return true;
      }
    }
    // Tentar variável de ambiente como fallback
    if (process.env.ML_USER_TOKEN && process.env.ML_USER_TOKEN_EXPIRY) {
      const expiry = parseInt(process.env.ML_USER_TOKEN_EXPIRY);
      if (Date.now() < expiry) {
        global._mlUserToken       = process.env.ML_USER_TOKEN;
        global._mlUserTokenExpiry = expiry;
        global._mlUserId          = process.env.ML_USER_ID;
        const min = Math.round((expiry - Date.now())/60000);
        console.log(`✅ Token ML restaurado de ENV — user ${process.env.ML_USER_ID}, válido por ${min} min`);
        return true;
      }
    }
  } catch(e) {
    console.log('Erro ao carregar token salvo:', e.message);
  }
  return false;
}

// Salvar token no Railway via API
async function saveTokenToRailway(token, expiry, userId) {
  const RAILWAY_TOKEN  = process.env.RAILWAY_TOKEN;
  const PROJECT_ID     = process.env.RAILWAY_PROJECT_ID   || '301862fd-6435-41a4-aef1-3fe0a3835873';
  const ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || '7ea3456f-a644-4867-922a-2de07f8f452c';
  const SERVICE_ID     = process.env.RAILWAY_SERVICE_ID   || '9bddbc7c-72f0-4f82-b599-d565e584d70e';

  if (!RAILWAY_TOKEN) {
    console.log('⚠️ RAILWAY_TOKEN não configurado — token não salvo em ENV');
    return false;
  }

  const mutation = `
    mutation {
      variableCollectionUpsert(input: {
        projectId: "${PROJECT_ID}"
        environmentId: "${ENVIRONMENT_ID}"
        serviceId: "${SERVICE_ID}"
        variables: {
          ML_USER_TOKEN: "${token}"
          ML_USER_TOKEN_EXPIRY: "${expiry}"
          ML_USER_ID: "${userId}"
        }
      })
    }
  `;

  try {
    const r = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RAILWAY_TOKEN}`
      },
      body: JSON.stringify({ query: mutation })
    });
    const d = await r.json();
    if (d.errors) {
      console.log('⚠️ Erro Railway API:', JSON.stringify(d.errors));
      return false;
    }
    console.log('✅ Token salvo nas variáveis do Railway');
    return true;
  } catch(e) {
    console.log('⚠️ Erro ao salvar no Railway:', e.message);
    return false;
  }
}

export async function handleOAuthCallback(req, res) {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>❌ Erro: ${error}</h2>`);
  if (!code) return res.redirect('/api/oauth/authorize');

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

    // 1. Salvar em memória
    global._mlUserToken       = data.access_token;
    global._mlUserTokenExpiry = expiryMs;
    global._mlUserId          = data.user_id;

    // 2. Salvar em disco
    try {
      writeFileSync(TOKEN_FILE, JSON.stringify({
        token: data.access_token, expiry: expiryMs,
        userId: data.user_id, savedAt: new Date().toISOString()
      }));
      console.log('✅ Token salvo em disco');
    } catch(e) { console.log('⚠️ Erro ao salvar em disco:', e.message); }

    // 3. Tentar salvar no Railway (silencioso se falhar)
    saveTokenToRailway(data.access_token, expiryMs, data.user_id);

    const horasValido = Math.round(data.expires_in / 3600);
    console.log(`✅ Token OAuth ativo — user ${data.user_id}, válido ${horasValido}h`);

    res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>DEXAN — Autorizado!</title>
      <style>
        body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4ff}
        .card{background:white;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:400px}
        a{display:inline-block;margin-top:20px;padding:12px 32px;background:linear-gradient(135deg,#1E40AF,#F97316);color:white;border-radius:8px;text-decoration:none;font-weight:bold}
      </style></head><body><div class="card">
        <div style="font-size:64px">✅</div>
        <h2 style="color:#1E40AF">Autorização concluída!</h2>
        <p>User ID ML: ${data.user_id}</p>
        <p>Token válido por: ${horasValido} horas</p>
        <p>Token salvo em memória no servidor.<br>O Radar v8 agora usará este token para buscas reais via /sites/MLB/search.</p>
        <a href="https://roadmap.dexancommerce.com/radar-dexan-v8">🎯 Ir para o DEXAN Radar v8</a>
      </div></body></html>
    `);
  } catch(err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`<h2>❌ Erro interno: ${err.message}</h2>`);
  }
}

export async function handleOAuthAuthorize(req, res) {
  const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>DEXAN — Autorizar ML</title>
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4ff}
      .card{background:white;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:400px}
      a{display:inline-block;margin-top:20px;padding:14px 36px;background:linear-gradient(135deg,#1E40AF,#F97316);color:white;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px}
    </style></head><body><div class="card">
      <h2>🔑 Autorizar conta ML</h2>
      <p>Clique abaixo para conectar a conta do Mercado Livre ao DEXAN Radar.</p>
      <a href="${authUrl}">Conectar conta Mercado Livre</a>
    </div></body></html>
  `);
}
