// routes/market.js — DEXAN Backend v4.0
// API ML real: domain_discovery + highlights + products/items + sold_quantity via API

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '3701874079446192';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'e5ZtVNh1Ltag4kGCKlwRFQuoG7zv0C3a';

let _token = null, _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
  });
  const d = await r.json();
  _token = d.access_token;
  _tokenExp = Date.now() + (d.expires_in - 300) * 1000;
  return _token;
}

async function mlGet(path) {
  const token = await getToken();
  const r = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`ML ${r.status} ${path.split('?')[0]}`);
  return r.json();
}

// Executa promises em paralelo com limite de concorrência
async function parallel(arr, fn, concurrency = 4) {
  const results = [];
  for (let i = 0; i < arr.length; i += concurrency) {
    const batch = arr.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : null));
  }
  return results.filter(Boolean);
}

async function fetchMarketData(product) {
  const q = encodeURIComponent(product);

  // 1. Descobrir categoria e domínio
  const [discovery, trends] = await Promise.allSettled([
    mlGet(`/sites/MLB/domain_discovery/search?q=${q}&limit=2`),
    mlGet(`/trends/MLB`)
  ]);

  const disc      = discovery.value?.[0] || {};
  const catId     = disc.category_id || null;
  const domainId  = disc.domain_id   || null;
  const catName   = disc.category_name || product;

  // 2. Total de anúncios + highlights em paralelo
  const [catData, hlData, prodSearch] = await Promise.allSettled([
    catId ? mlGet(`/categories/${catId}`) : Promise.resolve(null),
    catId ? mlGet(`/highlights/MLB/category/${catId}`) : Promise.resolve(null),
    mlGet(`/products/search?site_id=MLB&status=active&q=${q}&limit=15`)
  ]);

  const totalItems = catData.value?.total_items_in_this_category || null;

  // 3. Coletar product IDs para buscar seus items
  //    - Do highlights (top sellers da categoria)
  //    - Do products/search (mais amplo)
  const hlProductIds = (hlData.value?.content || [])
    .filter(c => c.id?.startsWith('MLB') && !c.id.startsWith('MLBU'))
    .map(c => c.id)
    .slice(0, 10);

  const searchProductIds = (prodSearch.value?.results || [])
    .map(p => p.id)
    .filter(id => !hlProductIds.includes(id))
    .slice(0, 10);

  const allProductIds = [...new Set([...hlProductIds, ...searchProductIds])].slice(0, 15);

  // 4. Buscar items de cada produto em paralelo (preço real, frete, fulfillment)
  const productItemsResults = await parallel(allProductIds, async (pid) => {
    try {
      const data = await mlGet(`/products/${pid}/items?limit=3`);
      return {
        productId: pid,
        items: (data.results || []).map(i => ({
          itemId:      i.item_id,
          sellerId:    i.seller_id,
          price:       i.price,
          origPrice:   i.original_price,
          freeShip:    i.shipping?.free_shipping || false,
          fulfillment: i.shipping?.logistic_type === 'fulfillment',
          listing:     i.listing_type_id,
          hasStore:    !!i.official_store_id,
          tags:        i.tags || []
        }))
      };
    } catch(e) { return null; }
  });

  // 5. Montar lista de items flat com nome do produto
  const prodNameMap = {};
  (prodSearch.value?.results || []).forEach(p => { prodNameMap[p.id] = p.name; });

  let allItems = [];
  for (const pr of productItemsResults) {
    if (!pr?.items?.length) continue;
    const prodName = prodNameMap[pr.productId] || '';
    for (const item of pr.items) {
      allItems.push({ ...item, productName: prodName });
    }
  }

  // Se não temos items de produtos, tentar products/search direto
  if (allItems.length === 0) {
    allItems = (prodSearch.value?.results || []).slice(0, 10).map(p => ({
      itemId:      p.id,
      productName: p.name,
      price:       null,
      freeShip:    null,
      fulfillment: null,
      listing:     null
    }));
  }

  // 6. Calcular métricas
  const precos = allItems.map(i => i.price).filter(p => p > 0 && p < 100000);
  const avg = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  const freeCount = allItems.filter(i => i.freeShip).length;
  const fullCount = allItems.filter(i => i.fulfillment).length;
  const goldCount = allItems.filter(i => ['gold_premium','gold_pro','gold_special'].includes(i.listing)).length;

  // Top sellers (ordenar por preço desc como proxy de popularidade)
  const topSellers = [...allItems]
    .filter(i => i.price)
    .sort((a,b) => b.price - a.price)
    .slice(0, 6)
    .map(i => ({
      title:        i.productName || i.itemId,
      price:        i.price,
      origPrice:    i.origPrice,
      soldQuantity: null,      // precisa de user token
      freeShipping: i.freeShip,
      fulfillment:  i.fulfillment,
      hasStore:     i.hasStore,
      listing:      i.listing,
      link:         `https://www.mercadolivre.com.br/p/${i.itemId}`
    }));

  // Tendências ML
  const trendingML = (trends.value || []).slice(0, 5).map(t => t.keyword);

  return {
    source: 'ml_api',
    query: product,
    categoryId: catId,
    categoryName: catName,
    domainId,
    totalItems,
    totalScraped: allItems.length,
    trendingML,
    prices: avg !== null ? {
      avg: +avg.toFixed(2),
      min: +Math.min(...precos).toFixed(2),
      max: +Math.max(...precos).toFixed(2)
    } : null,
    freeShippingPct: allItems.length ? Math.round((freeCount/allItems.length)*100) : 0,
    fulfillmentPct:  allItems.length ? Math.round((fullCount/allItems.length)*100) : 0,
    goldListingPct:  allItems.length ? Math.round((goldCount/allItems.length)*100) : 0,
    maxVendidosMes:  null,   // requer user token - usar dados do HTML
    avgRating:       null,   // idem
    topSellers
  };
}

async function fetchSerpApi(product) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY não configurada');
  const q   = encodeURIComponent(product + ' site:mercadolivre.com.br');
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${q}&gl=br&hl=pt&num=20&api_key=${key}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error('SerpApi ' + r.status);
  const data    = await r.json();
  const results = data.shopping_results || [];
  if (!results.length) return null;
  const precos = results
    .map(r => parseFloat(r.price?.replace(/[R$\s.]/g,'').replace(',','.')))
    .filter(p => !isNaN(p) && p > 0);
  const avg = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  return {
    source: 'serpapi_fallback',
    query: product,
    totalItems: null,
    prices: avg ? { avg: +avg.toFixed(2), min: Math.min(...precos), max: Math.max(...precos) } : null,
    freeShippingPct: 0,
    maxVendidosMes: null,
    avgRating: null,
    topSellers: results.slice(0, 5).map(r => ({
      title:        r.title,
      price:        parseFloat(r.price?.replace(/[R$\s.]/g,'').replace(',','.')) || null,
      soldQuantity: null,
      freeShipping: false,
      rating:       r.rating || null
    }))
  };
}

async function marketHandler(req, res) {
  const { product } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product obrigatório' });

  try {
    const data = await fetchMarketData(product);
    return res.json(data);
  } catch(err) {
    console.error('Market error:', err.message);
    try {
      const fallback = await fetchSerpApi(product);
      if (fallback) return res.json(fallback);
    } catch(e2) {}
    return res.status(500).json({ error: err.message });
  }
}

export { marketHandler as handleMarket };
