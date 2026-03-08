// api/test-proxy.js v3 — usando undici ProxyAgent (built-in Node 18)
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  const logs = [];

  logs.push(`user=${user?.substring(0,8)}... pass len=${pass?.length} host=${host}:${port}`);

  if (!user || !pass) return res.json({ ok: false, logs, error: 'Credenciais faltando' });

  try {
    const proxyUrl = `http://${user}:${encodeURIComponent(pass)}@${host}:${port}`;
    logs.push(`Criando ProxyAgent: ${host}:${port}`);

    const agent = new ProxyAgent(proxyUrl);

    logs.push('Fazendo request ML via proxy...');
    const response = await undiciFetch(
      'https://api.mercadolibre.com/sites/MLB/search?q=colete+de+peso&limit=3',
      {
        dispatcher: agent,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }
    );

    logs.push(`ML status: ${response.status}`);

    if (response.status === 200) {
      const data = await response.json();
      const items = data.results || [];
      logs.push(`✅ ML retornou ${items.length} itens! Total: ${data.paging?.total}`);
      return res.json({
        ok: true, logs,
        total: data.paging?.total,
        items: items.slice(0,3).map(i => ({ title: i.title, price: i.price, sold: i.sold_quantity }))
      });
    } else {
      const body = await response.text();
      logs.push(`Erro ML: ${body.substring(0,200)}`);
      return res.json({ ok: false, logs, mlStatus: response.status });
    }

  } catch(e) {
    logs.push(`ERRO: ${e.message}`);
    return res.json({ ok: false, logs, error: e.message });
  }
}
