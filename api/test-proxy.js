// api/test-proxy.js v5 — axios com proxy config
import axios from 'axios';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = parseInt(process.env.IPROYAL_PORT || '12321');
  const logs = [];

  logs.push(`user=${user?.substring(0,8)}... pass_len=${pass?.length} ${host}:${port}`);
  if (!user || !pass) return res.json({ ok: false, logs, error: 'Credenciais faltando' });

  try {
    logs.push('Fazendo request via axios proxy...');

    const response = await axios.get(
      'https://api.mercadolibre.com/sites/MLB/search?q=colete+de+peso&limit=3',
      {
        proxy: { host, port, auth: { username: user, password: pass }, protocol: 'http' },
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      }
    );

    const items = response.data.results || [];
    logs.push(`✅ ML retornou ${items.length} itens! Total: ${response.data.paging?.total}`);
    return res.json({
      ok: true, logs,
      total: response.data.paging?.total,
      items: items.slice(0,3).map(i => ({ title: i.title, price: i.price, sold: i.sold_quantity }))
    });

  } catch(e) {
    const status = e.response?.status;
    const msg = e.message;
    logs.push(`ERRO: ${msg} (HTTP ${status || 'N/A'})`);
    return res.json({ ok: false, logs, error: msg, httpStatus: status });
  }
}
