// server.js — DEXAN Backend v2.1 para Railway

import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

import { handleChat }         from './routes/chat.js';
import { handleMarket }       from './routes/market.js';
import { handleClaude }       from './routes/claude.js';
import { handleAuthCallback } from './routes/auth-callback.js';

app.post('/api/chat',    handleChat);
app.post('/api/market',  handleMarket);
app.post('/api/claude',  handleClaude);

// OAuth ML — rota correta (igual ao redirect_uri cadastrado no app ML)
app.get('/api/oauth/callback', handleAuthCallback);

// Rota auxiliar: gera a URL de autorização para clicar
app.get('/api/oauth/authorize', (req, res) => {
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_CLIENT_ID}&redirect_uri=https://dexan-chat-backend-production.up.railway.app/api/oauth/callback`;
  res.send(`
    <html>
    <head><title>DEXAN — Autorizar ML</title></head>
    <body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto;background:#0F172A;color:#F1F5F9">
      <h1>🔑 Autorizar conta ML</h1>
      <p>Clique abaixo para conectar a conta do Mercado Livre ao DEXAN Radar.</p>
      <p style="background:#1E293B;padding:12px;border-radius:8px;font-size:.8rem;color:#94A3B8;word-break:break-all">${url}</p>
      <a href="${url}" style="display:inline-block;margin-top:20px;background:#F97316;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700">
        Conectar conta Mercado Livre
      </a>
    </body></html>
  `);
});

// Health check
app.get('/',       (req, res) => res.json({ status: 'ok', service: 'DEXAN Backend', version: '2.1', oauthReady: !!global._mlUserToken }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`🚀 DEXAN Backend v2.1 na porta ${PORT}`);
  console.log(`🔑 OAuth authorize: https://dexan-chat-backend-production.up.railway.app/api/oauth/authorize`);
});
