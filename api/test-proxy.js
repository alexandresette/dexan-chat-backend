import { ProxyAgent } from 'undici';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const logs = [];

  // Testar múltiplas portas
  const ports = ['443', '8080', '12321'];

  for (const port of ports) {
    try {
      logs.push(`Testando porta ${port}...`);
      const client = new ProxyAgent({ uri: `http://${user}:${pass}@${host}:${port}`, connectTimeout: 8000 });
      const response = await fetch(
        'https://api.mercadolibre.com/sites/MLB/search?q=teste&limit=1',
        { dispatcher: client, headers: { 'Accept': 'application/json' } }
      );
      logs.push(`Porta ${port}: HTTP ${response.status}`);
      if (response.status === 200) {
        const data = await response.json();
        logs.push(`✅ PORTA ${port} FUNCIONOU! ${data.results?.length} itens`);
        return res.json({ ok: true, porta: port, logs, total: data.paging?.total });
      }
    } catch(e) {
      logs.push(`Porta ${port} ERRO: ${e.message} / ${e.cause?.message || ''}`);
    }
  }

  return res.json({ ok: false, logs, error: 'Nenhuma porta funcionou' });
}
