// server.js — DEXAN Backend v2.5
import express from 'express';
import cors from 'cors';
import { handleMarket } from './routes/market.js';
import { handleOAuthCallback, handleOAuthAuthorize, loadSavedToken } from './routes/auth-callback.js';
import { handleChat } from './routes/chat.js';
import { handleGetToken, handleAnalyze, handleSearchAndAnalyze } from './routes/validador.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

loadSavedToken();

app.post('/api/market', handleMarket);
app.post('/api/chat',   handleChat);
app.get('/api/oauth/callback',  handleOAuthCallback);
app.get('/api/oauth/authorize', handleOAuthAuthorize);

// DEXAN Validador
app.get('/api/ml-token',            handleGetToken);
app.post('/api/analyze',            handleAnalyze);
app.post('/api/search-and-analyze', handleSearchAndAnalyze);

app.get('/api/debug', async (req, res) => {
  const hasUserToken = !!(global._mlUserToken && Date.now() < (global._mlUserTokenExpiry || 0));
  const minutosRestantes = hasUserToken
    ? Math.round((global._mlUserTokenExpiry - Date.now()) / 60000)
    : 0;

  let mlTest = null;
  if (hasUserToken) {
    try {
      const r = await fetch('https://api.mercadolibre.com/sites/MLB/search?q=celular&limit=1', {
        headers: { Authorization: 'Bearer ' + global._mlUserToken }
      });
      const d = await r.json();
      mlTest = { status: r.status, total: d.paging?.total };
    } catch(e) { mlTest = { error: e.message }; }
  }

  res.json({
    version: 'v2.5 — DEXAN Validador',
    tokenOAuth: { hasToken: hasUserToken, userId: global._mlUserId, minutosRestantes },
    mlSearchComOAuth: mlTest,
    loginUrl: 'https://dexan-chat-backend-production.up.railway.app/api/oauth/authorize'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('DEXAN Backend v2.5 porta ' + PORT));
