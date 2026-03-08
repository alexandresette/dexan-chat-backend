import { ProxyAgent } from 'undici';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const logs = [];

  // Portas para testar - 8080 chegou nos IPs, 11200-11203 são do dashboard
  const ports = ['8080', '11200', '11201', '3128'];

  for (const port of ports) {
    try {
      logs.push(`Testando ${host}:${port}...`);
      const client = new ProxyAgent({
        uri: `http://${user}:${pass}@${host}:${port}`,
        connectTimeout: 20000,
        headersTimeout: 20000
      });
      const response = await fetch(
        'https://api.mercadolibre.com/sites/MLB/search?q=teste&limit=1',
        { dispatcher: client, headers: { 'Accept': 'application/json' } }
      );
      logs.push(`Porta ${port}: HTTP ${response.status}`);
      if (response.status === 200) {
        const data = await response.json();
        logs.push(`✅ FUNCIONOU porta ${port}! ${data.paging?.total} resultados`);
        return res.json({ ok: true, porta: port, logs, total: data.paging?.total });
      }
      if (response.status === 407) {
        logs.push(`Porta ${port}: 407 auth falhou`);
      }
    } catch(e) {
      const cause = e.cause?.message || e.cause?.code || '';
      logs.push(`Porta ${port} erro: ${cause || e.message}`);
    }
  }

  return res.json({ ok: false, logs });
}
