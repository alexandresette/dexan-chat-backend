// server.js — DEXAN Backend v2.7
import express from 'express';
import cors from 'cors';
import { handleMarket } from './routes/market.js';
import { handleOAuthCallback, handleOAuthAuthorize, loadSavedToken } from './routes/auth-callback.js';
import { handleChat } from './routes/chat.js';
import { handleGetToken, handleAnalyze, handleValidar } from './routes/validador.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

loadSavedToken();

app.post('/api/market',         handleMarket);
app.post('/api/chat',           handleChat);
app.get('/api/oauth/callback',  handleOAuthCallback);
app.get('/api/oauth/authorize', handleOAuthAuthorize);
app.get('/api/ml-token',        handleGetToken);
app.post('/api/analyze',        handleAnalyze);
app.post('/api/validar',        handleValidar);

app.get('/api/debug', async (req, res) => {
  const hasOAuth = !!(global._mlUserToken && Date.now() < global._mlUserTokenExpiry);
  const minLeft  = hasOAuth ? Math.round((global._mlUserTokenExpiry - Date.now()) / 60000) : 0;

  // Testa sites/MLB/search com user token diretamente
  let mlTest = null;
  if (hasOAuth) {
    try {
      const r = await fetch('https://api.mercadolibre.com/sites/MLB/search?q=coleira+gps&limit=3', {
        headers: { Authorization: `Bearer ${global._mlUserToken}` }
      });
      const d = await r.json();
      mlTest = {
        status: r.status,
        total: d.paging?.total,
        filtros: d.available_filters?.length,
        erro: d.error || null,
        tokenPrefix: global._mlUserToken?.slice(0,20)
      };
    } catch(e) {
      mlTest = { erro: e.message };
    }
  }

  res.json({
    version: 'v2.7 — DEXAN Validador',
    oauthAtivo: hasOAuth,
    userId: global._mlUserId || null,
    minutosRestantes: minLeft,
    modo: hasOAuth ? 'COMPLETO (sites/MLB/search)' : 'FALLBACK (products/search)',
    mlSearchTest: mlTest,
    loginUrl: 'https://dexan-chat-backend-production.up.railway.app/api/oauth/authorize',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DEXAN Backend v2.7 na porta ${PORT}`));
