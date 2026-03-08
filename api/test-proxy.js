// api/test-proxy.js — endpoint temporário de diagnóstico
import https from 'https';
import http from 'http';
import { URL } from 'url';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';

  const logs = [];
  logs.push(`vars: user=${user ? user.substring(0,8)+'...' : 'FALTANDO'}, pass=${pass ? 'OK' : 'FALTANDO'}, host=${host}, port=${port}`);

  if (!user || !pass) {
    return res.json({ ok: false, logs, error: 'Credenciais não configuradas' });
  }

  try {
    const proxyUrl = `http://${user}:${encodeURIComponent(pass)}@${host}:${port}`;
    logs.push(`Conectando ao proxy: ${host}:${port}`);

    const result = await new Promise((resolve, reject) => {
      const proxy = new URL(proxyUrl);
      const connectReq = http.request({
        host: proxy.hostname,
        port: parseInt(proxy.port),
        method: 'CONNECT',
        path: 'api.mercadolibre.com:443',
        headers: {
          'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${decodeURIComponent(proxy.password)}`).toString('base64'),
          'Host': 'api.mercadolibre.com'
        },
        timeout: 12000
      });

      connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('CONNECT timeout 12s')); });

      connectReq.on('connect', (resp, socket) => {
        logs.push(`CONNECT status: ${resp.statusCode}`);
        if (resp.statusCode !== 200) {
          socket.destroy();
          return reject(new Error(`CONNECT failed: ${resp.statusCode}`));
        }

        const tlsSocket = require('tls').connect({
          host: 'api.mercadolibre.com',
          socket,
          servername: 'api.mercadolibre.com'
        }, () => {
          logs.push('TLS OK, fazendo request GET...');
          const getReq = https.request({
            host: 'api.mercadolibre.com',
            path: '/sites/MLB/search?q=colete+de+peso&limit=3',
            method: 'GET',
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            createConnection: () => tlsSocket
          });
          getReq.on('response', r => {
            let body = '';
            r.on('data', d => body += d);
            r.on('end', () => resolve({ status: r.statusCode, body: body.substring(0, 500) }));
          });
          getReq.on('error', reject);
          getReq.end();
        });
        tlsSocket.on('error', reject);
      });
      connectReq.on('error', reject);
      connectReq.end();
    });

    logs.push(`ML status: ${result.status}`);
    if (result.status === 200) {
      const data = JSON.parse(result.body || '{}');
      logs.push(`✅ ML retornou ${data.results?.length || 0} itens`);
      return res.json({ ok: true, logs, items: data.results?.slice(0,2).map(i => ({title: i.title, price: i.price})) });
    } else {
      return res.json({ ok: false, logs, mlStatus: result.status, body: result.body });
    }
  } catch (e) {
    logs.push(`ERRO: ${e.message}`);
    return res.json({ ok: false, logs, error: e.message });
  }
}
