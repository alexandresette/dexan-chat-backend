// api/test-proxy.js v4 — undici ProxyAgent com import correto
import { ProxyAgent } from 'undici';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  const logs = [];

  logs.push(`user=${user?.substring(0,8)}... pass_len=${pass?.length} ${host}:${port}`);
  if (!user || !pass) return res.json({ ok: false, logs, error: 'Credenciais faltando' });

  try {
    const proxyUrl = `http://${user}:${encodeURIComponent(pass)}@${host}:${port}`;
    const agent = new ProxyAgent(proxyUrl);
    logs.push('ProxyAgent criado, fazendo request...');

    const response = await fetch(
      'https://api.mercadolibre.com/sites/MLB/search?q=colete+de+peso&limit=3',
      {
        dispatcher: agent,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }
    );

    logs.push(`ML HTTP status: ${response.status}`);

    if (response.status === 200) {
      const data = await response.json();
      logs.push(`✅ ${data.results?.length} itens! Total ML: ${data.paging?.total}`);
      return res.json({
        ok: true, logs,
        total: data.paging?.total,
        items: data.results?.slice(0,3).map(i => ({ title: i.title, price: i.price, sold: i.sold_quantity }))
      });
    }
    const body = await response.text();
    return res.json({ ok: false, logs, mlStatus: response.status, body: body.substring(0,300) });

  } catch(e) {
    logs.push(`ERRO: ${e.message}`);
    return res.json({ ok: false, logs, error: e.message });
  }
}
