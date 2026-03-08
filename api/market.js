// api/market.js — DEXAN Backend v8
// ML API via proxy IPRoyal usando https.request nativo do Node + fallback SerpApi

import https from 'https';
import http from 'http';
import { URL } from 'url';

function fetchViaProxy(targetUrl, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy  = new URL(proxyUrl);

    // HTTP CONNECT tunnel para HTTPS
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: {
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'),
        'Host': target.hostname
      }
    });

    connectReq.setTimeout(15000, () => { connectReq.destroy(); reject(new Error('Proxy connect timeout')); });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }

      const getReq = https.request({
        host: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Host': target.hostname
        },
        socket,
        agent: false
      });

      getReq.setTimeout(15000, () => { getReq.destroy(); reject(new Error('Request timeout')); });

      getReq.on('response', (resp) => {
        let body = '';
        resp.on('data', d => body += d);
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            return reject(new Error(`HTTP ${resp.statusCode}: ${body.substring(0,100)}`));
          }
          try { resolve(JSON.parse(body)); }
          catch(e) { reject(new Error('JSON parse error: ' + body.substring(0,100))); }
        });
      });

      getReq.on('error', reject);
      getReq.end();
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { product, source } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product required' });

  try {
    if (source === 'mercadolivre') return res.json(await fetchML(product));
    return res.status(400).json({ error: 'source inválida. Use: mercadolivre' });
  } catch (err) {
    console.error('market error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchML(product) {
  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';

  if (user && pass) {
    try {
      const proxyUrl = `http://${user}:${encodeURIComponent(pass)}@${host}:${port}`;
      const q = encodeURIComponent(product);
      const targetUrl = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=20&sort=relevance`;

      const data = await fetchViaProxy(targetUrl, proxyUrl);
      const items = data.results || [];

      if (items.length > 0) {
        console.log(`✅ ML via IPRoyal proxy: ${items.length} items`);
        return formatMLNative(product, items, data.paging?.total);
      }
      console.log('ML proxy retornou 0 itens');
    } catch (e) {
      console.log('Proxy falhou:', e.message, '— usando SerpApi');
    }
  } else {
    console.log('Sem credenciais proxy, usando SerpApi');
  }

  return fetchMLViaSerpApi(product);
}

function formatMLNative(product, items, total) {
  const prices = items.map(i => parseFloat(i.price)).filter(p => p > 0);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const freeCount = items.filter(i => i.shipping?.free_shipping).length;
  return {
    source: 'ml_native_proxy',
    query: product,
    totalItems: total || items.length,
    prices: {
      avg: +avg.toFixed(2),
      min: +Math.min(...prices).toFixed(2),
      max: +Math.max(...prices).toFixed(2)
    },
    freeShippingPct: Math.round((freeCount / items.length) * 100),
    topSellers: items.slice(0, 6).map(i => ({
      title: i.title,
      price: parseFloat(i.price),
      soldQuantity: i.sold_quantity || 0,
      rating: i.reviews?.rating_average ? +i.reviews.rating_average.toFixed(1) : null,
      freeShipping: i.shipping?.free_shipping || false,
      fulfillment: i.shipping?.logistic_type === 'fulfillment',
      condition: i.condition,
      link: i.permalink
    }))
  };
}

async function fetchMLViaSerpApi(product) {
  const serpKey = process.env.SERPAPI_KEY;
  if (!serpKey) return { error: 'Sem SERPAPI_KEY', totalItems: 0 };
  const q = encodeURIComponent(product);
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${q}&gl=br&hl=pt-BR&location=Brazil&api_key=${serpKey}&num=40`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('SerpApi error: ' + resp.status);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  const all = data.shopping_results || [];
  if (!all.length) return { error: 'Sem resultados', totalItems: 0 };
  const mlItems = all.filter(i => String(i.source || '').toLowerCase().includes('mercado'));
  const primary = mlItems.length >= 3 ? mlItems : all;
  const ep = p => {
    if (!p) return null;
    const n = parseFloat(String(p).replace(/[^\d,\.]/g, '').replace(',', '.'));
    return n > 0 && n < 50000 ? n : null;
  };
  const prices = primary.map(i => ep(i.price)).filter(Boolean);
  if (!prices.length) return { error: 'Sem preços válidos', totalItems: 0 };
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  return {
    source: 'serpapi_shopping',
    query: product,
    totalItems: mlItems.length >= 3 ? mlItems.length : all.length,
    prices: { avg: +avg.toFixed(2), min: +Math.min(...prices).toFixed(2), max: +Math.max(...prices).toFixed(2) },
    freeShippingPct: 0,
    topSellers: primary.slice(0, 6).map(i => ({
      title: i.title || 'Produto',
      price: ep(i.price),
      soldQuantity: null,
      rating: i.rating ? parseFloat(i.rating) : null,
      freeShipping: false,
      isML: String(i.source || '').toLowerCase().includes('mercado'),
      source: i.source
    }))
  };
}
