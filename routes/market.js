// routes/market.js — DEXAN Backend v2.0 Railway
// ML API via ProxyAgent undici (sem restrições no Railway!)

import { ProxyAgent } from 'undici';

async function fetchMLViaNativeProxy(product) {
  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';

  if (!user || !pass) throw new Error('Credenciais proxy não configuradas');

  const client = new ProxyAgent({
    uri: `http://${user}:${pass}@${host}:${port}`,
    connectTimeout: 20000,
    headersTimeout: 20000
  });

  const q = encodeURIComponent(product);
  const response = await fetch(
    `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=20&sort=relevance`,
    {
      dispatcher: client,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    }
  );

  if (!response.ok) throw new Error(`ML HTTP ${response.status}`);
  return response.json();
}

async function fetchMLViaSerpApi(product) {
  const serpKey = process.env.SERPAPI_KEY;
  if (!serpKey) return { error: 'Sem SERPAPI_KEY', totalItems: 0, topSellers: [] };

  const q = encodeURIComponent(product);
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${q}&gl=br&hl=pt-BR&location=Brazil&api_key=${serpKey}&num=40`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error('SerpApi error: ' + resp.status);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);

  const all = data.shopping_results || [];
  if (!all.length) return { error: 'Sem resultados', totalItems: 0, topSellers: [] };

  const mlItems = all.filter(i => String(i.source || '').toLowerCase().includes('mercado'));
  const primary = mlItems.length >= 3 ? mlItems : all;

  const ep = p => {
    if (!p) return null;
    const n = parseFloat(String(p).replace(/[^\d,\.]/g, '').replace(',', '.'));
    return n > 0 && n < 50000 ? n : null;
  };

  const prices = primary.map(i => ep(i.price)).filter(Boolean);
  if (!prices.length) return { error: 'Sem preços válidos', totalItems: 0, topSellers: [] };

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

export async function handleMarket(req, res) {
  const { product, source } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product required' });
  if (source && source !== 'mercadolivre')
    return res.status(400).json({ error: 'source inválida. Use: mercadolivre' });

  // Tentar proxy ML nativo primeiro
  try {
    console.log(`[market] tentando ML nativo via proxy para: ${product}`);
    const data = await fetchMLViaNativeProxy(product);
    const items = data.results || [];
    if (items.length > 0) {
      console.log(`[market] ✅ ML nativo via proxy: ${items.length} itens`);
      return res.json(formatMLNative(product, items, data.paging?.total));
    }
    console.log('[market] ML proxy retornou 0 itens, fallback SerpApi');
  } catch (e) {
    console.log(`[market] proxy falhou: ${e.message} — fallback SerpApi`);
  }

  // Fallback SerpApi
  try {
    const result = await fetchMLViaSerpApi(product);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
