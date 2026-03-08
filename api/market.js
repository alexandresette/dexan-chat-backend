// api/market.js — DEXAN Backend v4
// Sources: mercadolivre (ML API + fallback SerpApi)

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
      return res.json(await fetchMercadoLivre(product));
    }
    return res.status(400).json({ error: 'source inválida. Use: mercadolivre' });
  } catch (err) {
    console.error('market error:', err);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}

// ── MERCADO LIVRE ─────────────────────────────────────────
async function fetchMercadoLivre(product) {
  // Tenta ML API oficial primeiro
  try {
    const mlResult = await fetchMLNative(product);
    if (mlResult && !mlResult.error) return mlResult;
  } catch (e) {
    console.log('ML native failed, trying SerpApi fallback:', e.message);
  }

  // Fallback: SerpApi Google Shopping filtrando ML
  const serpKey = process.env.SERPAPI_KEY;
  if (serpKey) {
    try {
      return await fetchMLViaSerpApi(product, serpKey);
    } catch (e) {
      console.log('SerpApi fallback also failed:', e.message);
    }
  }

  return { error: 'Não foi possível buscar dados do ML. Tente novamente.', totalItems: 0 };
}

// ── ML API OFICIAL ────────────────────────────────────────
async function fetchMLNative(product) {
  const query = encodeURIComponent(product);
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${query}&limit=20&sort=relevance`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; DEXAN-Radar/4.0)'
    }
  });

  if (response.status === 403) {
    throw new Error('ML API 403 - needs OAuth');
  }
  if (!response.ok) {
    throw new Error(`ML API error: ${response.status}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.message || data.error);

  const items = data.results || [];
  if (!items.length) return { error: 'Nenhum resultado no ML', totalItems: 0 };

  return formatMLResponse(product, items, data.paging?.total || items.length);
}

// ── SERPAPI FALLBACK: Google Shopping filtrando ML ────────
async function fetchMLViaSerpApi(product, apiKey) {
  // Busca no Google Shopping com filtro de site ML
  const query = encodeURIComponent(`${product} site:mercadolivre.com.br`);
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${query}&gl=br&hl=pt&api_key=${apiKey}&num=10`;

  const response = await fetch(url);
  if (!response.ok) throw new Error('SerpApi error: ' + response.status);

  const data = await response.json();
  if (data.error) throw new Error(data.error);

  const items = data.shopping_results || [];
  if (!items.length) {
    // Segunda tentativa: busca direta no ML sem filtro site
    const query2 = encodeURIComponent(product);
    const url2 = `https://serpapi.com/search.json?engine=google_shopping&q=${query2}&gl=br&hl=pt&api_key=${apiKey}&num=10`;
    const r2 = await fetch(url2);
    const d2 = await r2.json();
    const items2 = d2.shopping_results || [];
    if (!items2.length) return { error: 'Sem resultados', totalItems: 0 };
    return formatSerpResponse(product, items2);
  }

  return formatSerpResponse(product, items);
}

// ── FORMAT ML NATIVE RESPONSE ─────────────────────────────
function formatMLResponse(product, items, total) {
  const prices = items.map(i => parseFloat(i.price)).filter(p => p > 0);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const freeShipping = items.filter(i => i.shipping?.free_shipping).length;

  const topSellers = items.slice(0, 6).map(i => ({
    id: i.id,
    title: i.title,
    price: parseFloat(i.price),
    soldQuantity: i.sold_quantity || 0,
    rating: i.reviews?.rating_average ? parseFloat(i.reviews.rating_average.toFixed(1)) : null,
    freeShipping: i.shipping?.free_shipping || false,
    condition: i.condition,
    fulfillment: i.shipping?.logistic_type === 'fulfillment'
  }));

  return {
    source: 'ml_native',
    query: product,
    totalItems: total,
    prices: {
      avg: parseFloat(avgPrice.toFixed(2)),
      min: parseFloat(minPrice.toFixed(2)),
      max: parseFloat(maxPrice.toFixed(2))
    },
    freeShippingPct: Math.round((freeShipping / items.length) * 100),
    topSellers,
    timestamp: new Date().toISOString()
  };
}

// ── FORMAT SERPAPI RESPONSE ───────────────────────────────
function formatSerpResponse(product, items) {
  const extractPrice = (p) => {
    if (!p) return null;
    if (typeof p === 'number') return p;
    const match = String(p).replace(/[^\d,\.]/g, '').replace(',', '.');
    return parseFloat(match) || null;
  };

  const prices = items.map(i => extractPrice(i.price)).filter(p => p && p > 0);
  if (!prices.length) return { error: 'Sem preços encontrados', totalItems: 0 };

  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  const topSellers = items.slice(0, 6).map(i => ({
    title: i.title || i.name || 'Produto',
    price: extractPrice(i.price),
    soldQuantity: null,
    rating: i.rating ? parseFloat(i.rating) : null,
    freeShipping: false,
    condition: 'new'
  }));

  return {
    source: 'serpapi_fallback',
    query: product,
    totalItems: items.length,
    prices: {
      avg: parseFloat(avgPrice.toFixed(2)),
      min: parseFloat(Math.min(...prices).toFixed(2)),
      max: parseFloat(Math.max(...prices).toFixed(2))
    },
    freeShippingPct: 0,
    topSellers,
    timestamp: new Date().toISOString()
  };
}
