// api/test-proxy.js — diagnóstico v2 com ES module correto
import http from 'http';
import tls from 'tls';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = parseInt(process.env.IPROYAL_PORT || '12321');
  const logs = [];

  logs.push(`user=${user ? user.substring(0,8)+'...' : 'FALTANDO'}`);
  logs.push(`pass=${pass ? pass.substring(0,8)+'...(len='+pass.length+')' : 'FALTANDO'}`);
  logs.push(`host=${host}, port=${port}`);

  if (!user || !pass) return res.json({ ok: false, logs, error: 'Credenciais faltando' });

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  try {
    const result = await new Promise((resolve, reject) => {
      const req2 = http.request({
        host, port,
        method: 'CONNECT',
        path: 'api.mercadolibre.com:443',
        headers: {
          'Proxy-Authorization': `Basic ${auth}`,
          'Host': 'api.mercadolibre.com:443'
        },
        timeout: 12000
      });

      req2.on('timeout', () => { req2.destroy(); reject(new Error('CONNECT timeout')); });
      req2.on('error', reject);

      req2.on('connect', (response, socket) => {
        logs.push(`CONNECT status: ${response.statusCode}`);
        if (response.statusCode !== 200) {
          socket.destroy();
          return reject(new Error(`CONNECT falhou: ${response.statusCode}`));
        }

        const tlsSock = tls.connect({
          host: 'api.mercadolibre.com',
          socket,
          servername: 'api.mercadolibre.com'
        });

        tlsSock.on('secureConnect', () => {
          logs.push('TLS OK! Fazendo GET...');
          const getReq = `GET /sites/MLB/search?q=colete+de+peso&limit=3 HTTP/1.1\r\nHost: api.mercadolibre.com\r\nAccept: application/json\r\nConnection: close\r\n\r\n`;
          tlsSock.write(getReq);

          let data = '';
          tlsSock.on('data', chunk => data += chunk);
          tlsSock.on('end', () => {
            const parts = data.split('\r\n\r\n');
            const body = parts.slice(1).join('');
            try {
              const json = JSON.parse(body);
              resolve({ status: 200, items: json.results?.length || 0, sample: json.results?.slice(0,2).map(i => i.title) });
            } catch(e) {
              resolve({ status: 200, rawBody: body.substring(0,200) });
            }
          });
        });

        tlsSock.on('error', reject);
      });

      req2.end();
    });

    logs.push(`✅ ML retornou ${result.items} itens!`);
    return res.json({ ok: true, logs, result });

  } catch(e) {
    logs.push(`ERRO: ${e.message}`);
    return res.json({ ok: false, logs, error: e.message });
  }
}
