// server.js — DEXAN Backend v2.5
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

app.post('/api/market',           handleMarket);
app.post('/api/chat',             handleChat);
app.get('/api/oauth/callback',    handleOAuthCallback);
app.get('/api/oauth/authorize',   handleOAuthAuthorize);

// DEXAN Validador
app.get('/api/ml-token',          handleGetToken);
app.post('/api/analyze',          handleAnalyze);
app.post('/api/validar',          handleValidar);  // novo — full backend proxy

app.get('/api/debug', async (req, res) => {
  res.json({ version: 'v2.5 — DEXAN Validador full-proxy' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DEXAN Backend v2.5 rodando na porta ${PORT}`));
