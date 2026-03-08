// server.js — DEXAN Backend v2.2
import express from 'express';
import cors from 'cors';
import { handleMarket } from './routes/market.js';
import { handleOAuthCallback, handleOAuthAuthorize, loadSavedToken } from './routes/auth-callback.js';
import { handleChat } from './routes/chat.js';

const app = express();
app.use(cors());
app.use(express.json());

// Tentar restaurar token salvo ao iniciar
loadSavedToken();

app.post('/api/market', handleMarket);
app.post('/api/chat',   handleChat);
app.get('/api/oauth/callback',  handleOAuthCallback);
app.get('/api/oauth/authorize', handleOAuthAuthorize);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DEXAN Backend v2.2 rodando na porta ${PORT}`));
