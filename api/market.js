// api/market.js — DEXAN Backend v7
// ML API via proxy residencial BR (IPRoyal) usando undici + fallback SerpApi

import { ProxyAgent, fetch as uFetch } from 'undici';

function getProxyFetch() {
  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  if (!user || !pass) return null;

  const dispatcher = new ProxyAgent(`http://${user}:${pass}@${host}:${port}`);
  return (url, opts = {}) => uFetch(url, { ...opts, dispatcher });
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
  const proxyFetch = getProxyFetch();

  if (proxyFetch) {
    try {
      const q = encodeURIComponent(product);
      const url = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=20&sort=relevance`;
      const resp = await proxyFetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });
      if (resp.ok) {
        const data = await resp.json();
        const items = data.results || [];
        if (items.length > 0) {
          console.log(`✅ ML via IPRoyal: ${items.length} items`);
          return formatMLNative(product, items, data.paging?.total);
        }
        console.log('ML proxy retornou vazio, status:', resp.status);
      } else {
        const txt = await resp.text().catch(() => '');
        console.log(`ML proxy HTTP ${resp.status}:`, txt.substring(0, 100));
      }
    } catch (e) {
      console.log('Proxy erro:', e.message);
    }
  } else {
    console.log('Sem credenciais IPRoyal, usando SerpApi');
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
