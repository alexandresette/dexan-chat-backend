// server.js — DEXAN Backend v2.4
import express from 'express';
import cors from 'cors';
import { handleMarket } from './routes/market.js';
import { handleOAuthCallback, handleOAuthAuthorize, loadSavedToken } from './routes/auth-callback.js';
import { handleChat } from './routes/chat.js';
import { handleGetToken, handleAnalyze } from './routes/validador.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Restaurar token salvo ao iniciar
loadSavedToken();

// Rotas existentes
app.post('/api/market', handleMarket);
app.post('/api/chat',   handleChat);
app.get('/api/oauth/callback',  handleOAuthCallback);
app.get('/api/oauth/authorize', handleOAuthAuthorize);

// DEXAN Validador — novos endpoints
app.get('/api/ml-token',  handleGetToken);
app.post('/api/analyze',  handleAnalyze);

// Diagnóstico
app.get('/api/debug', async (req, res) => {
  const hasToken = !!global._mlUserToken;
  const expiry = global._mlUserTokenExpiry;
  const userId = global._mlUserId;
  const minutosRestantes = expiry ? Math.round((expiry - Date.now()) / 60000) : 0;

  let mlTest = null;
  if (hasToken) {
    try {
      const r = await fetch('https://api.mercadolibre.com/sites/MLB/search?q=celular&limit=1', {
        headers: { Authorization: `Bearer ${global._mlUserToken}` }
      });
      const d = await r.json();
      mlTest = { status: r.status, total: d.paging?.total, error: d.error };
    } catch(e) {
      mlTest = { error: e.message };
    }
  }

  let ccTest = null;
  try {
    const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
    const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
    const r2 = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
    });
    const d2 = await r2.json();
    if (d2.access_token) {
      const r3 = await fetch('https://api.mercadolibre.com/sites/MLB/search?q=celular&limit=1', {
        headers: { Authorization: `Bearer ${d2.access_token}` }
      });
      const d3 = await r3.json();
      ccTest = { status: r3.status, total: d3.paging?.total, error: d3.error };
    }
  } catch(e) {
    ccTest = { error: e.message };
  }

  res.json({
    version: 'v2.4 — DEXAN Validador',
    tokenOAuth: { hasToken, userId, minutosRestantes },
    mlSearchComOAuth: mlTest,
    mlSearchComCC: ccTest
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DEXAN Backend v2.4 rodando na porta ${PORT}`));
