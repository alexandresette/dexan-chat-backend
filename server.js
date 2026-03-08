// server.js — DEXAN Backend v2.0 para Railway
// Express.js sem restrições de rede (proxy IPRoyal funciona aqui!)

import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---- Rotas ----
import { handleChat }         from './routes/chat.js';
import { handleMarket }       from './routes/market.js';
import { handleClaude }       from './routes/claude.js';
import { handleAuthCallback } from './routes/auth-callback.js';

app.post('/api/chat',           handleChat);
app.post('/api/market',         handleMarket);
app.post('/api/claude',         handleClaude);
app.get('/api/auth-callback',   handleAuthCallback);
app.get('/api/test-proxy',      handleTestProxy);

// Health check
app.get('/',        (req, res) => res.json({ status: 'ok', service: 'DEXAN Backend', version: '2.0' }));
app.get('/health',  (req, res) => res.json({ status: 'ok' }));

// Test proxy
async function handleTestProxy(req, res) {
  const { ProxyAgent } = await import('undici');
  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  const logs = [];
  logs.push(`user=${user?.substring(0,8)}... pass_len=${pass?.length} ${host}:${port}`);
  if (!user || !pass) return res.json({ ok: false, logs, error: 'Credenciais faltando' });
  try {
    const client = new ProxyAgent({ uri: `http://${user}:${pass}@${host}:${port}`, connectTimeout: 15000 });
    const response = await fetch(
      'https://api.mercadolibre.com/sites/MLB/search?q=colete+de+peso&limit=3',
      { dispatcher: client, headers: { 'Accept': 'application/json' } }
    );
    logs.push(`ML status: ${response.status}`);
    if (response.status === 200) {
      const data = await response.json();
      logs.push(`✅ ${data.results?.length} itens! Total: ${data.paging?.total}`);
      return res.json({ ok: true, logs, total: data.paging?.total,
        items: data.results?.slice(0,3).map(i => ({ title: i.title, price: i.price, sold: i.sold_quantity }))
      });
    }
    return res.json({ ok: false, logs, mlStatus: response.status });
  } catch(e) {
    logs.push(`ERRO: ${e.message} / ${e.cause?.message || ''}`);
    return res.json({ ok: false, logs, error: e.message });
  }
}

app.listen(PORT, () => {
  console.log(`🚀 DEXAN Backend rodando na porta ${PORT}`);
});
