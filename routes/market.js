// routes/market.js — DEXAN Backend v3.0
// Usa API ML oficial (endpoints que funcionam sem aprovação especial)
// Estratégia: domain_discovery + highlights + items em lote

const ML_CLIENT_ID = process.env.ML_CLIENT_ID || '3701874079446192';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'e5ZtVNh1Ltag4kGCKlwRFQuoG7zv0C3a';

let cachedToken = null;
let tokenExpiry = 0;

async function getMLToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
  });
  if (!resp.ok) throw new Error('Falha token ML: ' + resp.status);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

async function mlFetch(url) {
  const token = await getMLToken();
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
  });
  if (!resp.ok) throw new Error(`ML API ${resp.status}: ${url.split('?')[0].split('/').slice(-2).join('/')}`);
  return resp.json();
}

async function fetchMarketData(product) {
  // 1. Descobrir categoria exata
  const discovery = await mlFetch(
    `https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${encodeURIComponent(product)}&limit=1`
  );
  const categoryId   = discovery[0]?.category_id   || null;
  const domainId     = discovery[0]?.domain_id     || null;
  const categoryName = discovery[0]?.category_name || product;

  // 2. Total de anúncios na categoria
  let totalAnuncios = null;
  if (categoryId) {
    try {
      const catData = await mlFetch(`https://api.mercadolibre.com/categories/${categoryId}`);
      totalAnuncios = catData.total_items_in_this_category;
    } catch(e) {}
  }

  // 3. Top sellers via highlights
  let topItemIds = [];
  if (categoryId) {
    try {
      const hl = await mlFetch(`https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`);
      topItemIds = (hl.content || [])
        .filter(c => c.id && c.id.startsWith('MLB') && !c.id.startsWith('MLBU') && c.id.length <= 13)
        .map(c => c.id)
        .slice(0, 20);
    } catch(e) {}
  }

  // 4. Detalhes dos items em lote
  let items = [];
  if (topItemIds.length > 0) {
    try {
      const batchUrl = `https://api.mercadolibre.com/items?ids=${topItemIds.join(',')}&attributes=id,title,price,sold_quantity,shipping,seller_id,condition,reviews_rating_summary`;
      const batchData = await mlFetch(batchUrl);
      items = batchData
        .filter(i => i.code === 200)
        .map(i => ({
          id:           i.body.id,
          title:        i.body.title,
          price:        i.body.price,
          soldQuantity: i.body.sold_quantity,
          freeShipping: i.body.shipping?.free_shipping || false,
          fulfillment:  i.body.shipping?.logistic_type === 'fulfillment',
          rating:       i.body.reviews_rating_summary?.rating_average || null,
          reviewsTotal: i.body.reviews_rating_summary?.total || null,
          condition:    i.body.condition,
          link:         `https://www.mercadolivre.com.br/p/${i.body.id}`
        }));
    } catch(e) {}
  }

  // 5. Fallback: products/search para nomes se items vazio
  if (items.length === 0) {
    try {
      const prodSearch = await mlFetch(
        `https://api.mercadolibre.com/products/search?site_id=MLB&status=active&q=${encodeURIComponent(product)}&limit=10`
      );
      items = (prodSearch.results || []).slice(0, 10).map(p => ({
        id:           p.id,
        title:        p.name,
        price:        null,
        soldQuantity: null,
        freeShipping: null,
        fulfillment:  null,
        rating:       null,
        condition:    'new'
      }));
    } catch(e) {}
  }

  // 6. Calcular métricas
  const precos = items.map(i => i.price).filter(p => p !== null && p > 0 && p < 100000);
  const avgPreco = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  const freteCount = items.filter(i => i.freeShipping).length;
  const freeShippingPct = items.length ? Math.round((freteCount/items.length)*100) : 0;
  const maxVendidos = items.some(i => i.soldQuantity !== null)
    ? Math.max(...items.filter(i => i.soldQuantity !== null).map(i => i.soldQuantity))
    : null;
  const comRating = items.filter(i => i.rating !== null);
  const avgRating = comRating.length
    ? +(comRating.reduce((a,b)=>a+b.rating,0)/comRating.length).toFixed(1)
    : null;

  const topSellers = [...items]
    .sort((a,b) => (b.soldQuantity||0) - (a.soldQuantity||0))
    .slice(0, 6);

  return {
    source: 'ml_api',
    query: product,
    categoryId,
    categoryName,
    domainId,
    totalItems: totalAnuncios,
    totalScraped: items.length,
    prices: avgPreco !== null ? {
      avg: +avgPreco.toFixed(2),
      min: +Math.min(...precos).toFixed(2),
      max: +Math.max(...precos).toFixed(2)
    } : null,
    freeShippingPct,
    maxVendidosMes: maxVendidos,
    avgRating,
    topSellers
  };
}

async function fetchSerpApi(product) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY não configurada');
  const q = encodeURIComponent(product + ' site:mercadolivre.com.br');
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${q}&gl=br&hl=pt&num=20&api_key=${key}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('SerpApi error ' + resp.status);
  const data = await resp.json();
  const results = data.shopping_results || [];
  if (!results.length) return null;
  const precos = results.map(r => parseFloat(r.price?.replace(/[R$\s.]/g,'').replace(',','.'))).filter(p=>!isNaN(p)&&p>0);
  const avg = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  return {
    source: 'serpapi_fallback',
    query: product,
    totalItems: null,
    prices: avg ? { avg: +avg.toFixed(2), min: Math.min(...precos), max: Math.max(...precos) } : null,
    freeShippingPct: 0,
    maxVendidosMes: null,
    avgRating: null,
    topSellers: results.slice(0,5).map(r => ({
      title: r.title,
      price: parseFloat(r.price?.replace(/[R$\s.]/g,'').replace(',','.')) || null,
      soldQuantity: null,
      freeShipping: false,
      rating: r.rating || null
    }))
  };
}

export default async function marketHandler(req, res) {
  const { product } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product obrigatório' });

  try {
    const data = await fetchMarketData(product);
    if (!data.prices && !data.topSellers.length) {
      try {
        const serpData = await fetchSerpApi(product);
        if (serpData) return res.json(serpData);
      } catch(e2) {}
    }
    return res.json(data);
  } catch (err) {
    console.error('Market error:', err.message);
    try {
      const serpData = await fetchSerpApi(product);
      if (serpData) return res.json(serpData);
    } catch(e2) {
      console.error('SerpApi fallback error:', e2.message);
    }
    return res.status(500).json({ error: 'Falha ao buscar dados: ' + err.message });
  }
}
