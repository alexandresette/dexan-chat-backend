// api/market.js — DEXAN Backend v5
// ML API oficial via OAuth2 client_credentials + fallback SerpApi

let mlTokenCache = { token: null, expiresAt: 0 };

async function getMLToken() {
  const now = Date.now();
  if (mlTokenCache.token && now < mlTokenCache.expiresAt - 60000) {
    return mlTokenCache.token;
  }
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('ML_CLIENT_ID / ML_CLIENT_SECRET não configurados');

  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`
  });
  if (!resp.ok) throw new Error('ML OAuth error: ' + resp.status);
  const data = await resp.json();
  if (!data.access_token) throw new Error(data.message || 'No token');

  mlTokenCache = { token: data.access_token, expiresAt: now + (data.expires_in * 1000) };
  return data.access_token;
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
    if (source === 'mercadolivre') {
      return res.json(await fetchML(product));
    }
    return res.status(400).json({ error: 'source inválida. Use: mercadolivre' });
  } catch (err) {
    console.error('market error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchML(product) {
  // Tentar ML API oficial com OAuth
  try {
    const token = await getMLToken();
    const q = encodeURIComponent(product);
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=20&sort=relevance`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (resp.ok) {
      const data = await resp.json();
      const items = data.results || [];
      if (items.length > 0) return formatMLNative(product, items, data.paging?.total);
    }
    console.log('ML native returned empty, trying SerpApi...');
  } catch (e) {
    console.log('ML OAuth failed:', e.message, '— trying SerpApi fallback');
  }

  // Fallback: SerpApi Google Shopping BR
  return fetchMLViaSerpApi(product);
}

function formatMLNative(product, items, total) {
  const prices = items.map(i => parseFloat(i.price)).filter(p => p > 0);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const freeCount = items.filter(i => i.shipping?.free_shipping).length;

  return {
    source: 'ml_native',
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
  if (!serpKey) return { error: 'Sem SERPAPI_KEY configurada', totalItems: 0 };

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
    mlItemsFound: mlItems.length,
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
    })),
    competitorSources: [...new Set(all.map(i => i.source).filter(Boolean))].slice(0, 6)
  };
}
