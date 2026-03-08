import { ProxyAgent } from 'undici';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  const logs = [];

  logs.push(`${user?.substring(0,8)}:${pass?.substring(0,8)}... @ ${host}:${port}`);

  try {
    const proxyUrl = `http://${user}:${pass}@${host}:${port}`;
    const client = new ProxyAgent({ uri: proxyUrl, connectTimeout: 15000, headersTimeout: 15000 });

    const response = await fetch(
      'https://api.mercadolibre.com/sites/MLB/search?q=colete+de+peso&limit=3',
      { dispatcher: client, headers: { 'Accept': 'application/json' } }
    );

    logs.push(`status: ${response.status}`);
    if (response.status === 200) {
      const data = await response.json();
      logs.push(`✅ ${data.results?.length} itens total=${data.paging?.total}`);
      return res.json({ ok: true, logs, total: data.paging?.total,
        items: data.results?.slice(0,3).map(i => ({ title: i.title, price: i.price, sold: i.sold_quantity }))
      });
    }
    return res.json({ ok: false, logs, mlStatus: response.status, body: (await response.text()).substring(0,300) });
  } catch(e) {
    // Log detalhado do erro
    logs.push(`ERRO tipo: ${e.constructor.name}`);
    logs.push(`ERRO msg: ${e.message}`);
    logs.push(`ERRO cause: ${e.cause?.message || e.cause || 'nenhum'}`);
    logs.push(`ERRO code: ${e.cause?.code || e.code || 'N/A'}`);
    return res.json({ ok: false, logs, error: e.message, cause: String(e.cause) });
  }
}
