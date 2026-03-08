// routes/market.js — DEXAN Backend v5.0
// API ML real: domain_discovery + highlights + products/items + reviews + seller_reputation

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '3701874079446192';
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
  if (!resp.ok) throw new Error(`ML ${resp.status}: ${url.split('?')[0].split('/').slice(-2).join('/')}`);
  return resp.json();
}

async function mlFetchSafe(url) {
  try { return await mlFetch(url); } catch(e) { return null; }
}

async function fetchMarketData(product) {
  // 1. Descobrir categoria exata
  const discovery = await mlFetch(
    `https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${encodeURIComponent(product)}&limit=1`
  );
  const categoryId   = discovery[0]?.category_id   || null;
  const categoryName = discovery[0]?.category_name || product;
  const domainId     = discovery[0]?.domain_id     || null;

  // 2. Total de anúncios + highlights em paralelo
  const [catData, hlData] = await Promise.all([
    categoryId ? mlFetchSafe(`https://api.mercadolibre.com/categories/${categoryId}`) : Promise.resolve(null),
    categoryId ? mlFetchSafe(`https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`) : Promise.resolve(null)
  ]);

  const totalAnuncios = catData?.total_items_in_this_category || null;

  // 3. Filtrar IDs de produtos do catálogo (tipo PRODUCT)
  const productIds = (hlData?.content || [])
    .filter(c => c.type === 'PRODUCT' && c.id?.startsWith('MLB'))
    .map(c => c.id)
    .slice(0, 6);

  // 4. Para cada produto, buscar o item vencedor (buy box)
  const productItemsRaw = await Promise.all(
    productIds.map(pid => mlFetchSafe(`https://api.mercadolibre.com/products/${pid}/items?limit=1`))
  );

  // 5. Extrair dados de cada item vencedor
  const itemDataList = productItemsRaw
    .filter(d => d?.results?.length > 0)
    .map(d => d.results[0]);

  // 6. Buscar reviews de cada item vencedor em paralelo (reviews = proxy de popularidade)
  const itemIds = itemDataList.map(i => i.item_id).filter(Boolean);
  const reviewsData = await Promise.all(
    itemIds.map(iid => mlFetchSafe(`https://api.mercadolibre.com/reviews/item/${iid}`))
  );

  // 7. Buscar seller_reputation em paralelo para os top sellers
  const sellerIds = [...new Set(itemDataList.map(i => i.seller_id).filter(Boolean))].slice(0, 3);
  const sellerData = await Promise.all(
    sellerIds.map(sid => mlFetchSafe(`https://api.mercadolibre.com/users/${sid}?attributes=id,nickname,seller_reputation`))
  );
  const sellerMap = {};
  sellerData.filter(Boolean).forEach(s => {
    if (s.id) sellerMap[s.id] = s;
  });

  // 8. Montar lista de top sellers com dados combinados
  const items = itemDataList.map((item, idx) => {
    const prodId = productIds[idx];
    const reviews = reviewsData[idx];
    const seller = sellerMap[item.seller_id];
    const totalReviews = reviews?.paging?.total || null;
    const sellerRep = seller?.seller_reputation;
    const sellerLevel = sellerRep?.level_id || null; // '5_green' = platinum
    const sellerTotalVendas = sellerRep?.transactions?.total || null;

    return {
      id:           item.item_id,
      title:        null, // não disponível no products/items - buscar via products
      price:        item.price,
      originalPrice: item.original_price,
      soldQuantity: null, // não disponível via app token
      totalReviews,       // proxy: número de avaliações do produto
      sellerTotalVendas,  // vendas históricas do vendedor
      sellerLevel,        // nível do seller (5_green = platinum)
      sellerNickname: seller?.nickname || null,
      freeShipping: item.shipping?.free_shipping || false,
      fulfillment:  item.shipping?.logistic_type === 'fulfillment',
      condition:    item.condition,
      link:         `https://www.mercadolivre.com.br/p/${prodId}`
    };
  });

  // 9. Buscar títulos via products search (complementar)
  const prodSearch = await mlFetchSafe(
    `https://api.mercadolibre.com/products/search?site_id=MLB&status=active&q=${encodeURIComponent(product)}&limit=10`
  );
  const prodNameMap = {};
  (prodSearch?.results || []).forEach(p => { prodNameMap[p.id] = p.name; });
  productIds.forEach((pid, i) => { if (items[i]) items[i].title = prodNameMap[pid] || null; });

  // 10. Calcular métricas
  const precos = items.map(i => i.price).filter(p => p != null && p > 0 && p < 100000);
  const avgPreco = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  const freteCount = items.filter(i => i.freeShipping).length;
  const freeShippingPct = items.length ? Math.round((freteCount/items.length)*100) : 0;
  const maxReviews = items.some(i => i.totalReviews) ? Math.max(...items.filter(i=>i.totalReviews).map(i=>i.totalReviews)) : null;

  // Ordenar por reviews (proxy de vendas)
  const topSellers = [...items]
    .sort((a,b) => (b.totalReviews||0) - (a.totalReviews||0))
    .slice(0, 6);

  return {
    source: 'ml_api_v5',
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
    maxVendidosMes: null, // API ML não expõe via app token sem permissão especial
    maxReviews,           // proxy de popularidade
    topSellers
  };
}

async function fetchSerpApi(product) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY não configurada');
  const q = encodeURIComponent(product + ' site:mercadolivre.com.br');
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${q}&gl=br&hl=pt&num=20&api_key=${key}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('SerpApi ' + resp.status);
  const data = await resp.json();
  const results = data.shopping_results || [];
  if (!results.length) return null;
  const precos = results.map(r=>parseFloat(r.price?.replace(/[R$\s.]/g,'').replace(',','.'))).filter(p=>!isNaN(p)&&p>0);
  const avg = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  return {
    source: 'serpapi_fallback',
    query: product, totalItems: null,
    prices: avg ? { avg: +avg.toFixed(2), min: Math.min(...precos), max: Math.max(...precos) } : null,
    freeShippingPct: 0, maxVendidosMes: null, maxReviews: null,
    topSellers: results.slice(0,5).map(r=>({
      title: r.title, price: parseFloat(r.price?.replace(/[R$\s.]/g,'').replace(',','.')) || null,
      soldQuantity: null, totalReviews: null, freeShipping: false, rating: r.rating || null
    }))
  };
}

async function handleMarket(req, res) {
  const { product } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product obrigatório' });
  try {
    const data = await fetchMarketData(product);
    if (!data.prices && !data.topSellers.length) {
      const serpData = await fetchSerpApi(product).catch(()=>null);
      if (serpData) return res.json(serpData);
    }
    return res.json(data);
  } catch(err) {
    console.error('Market error:', err.message);
    const serpData = await fetchSerpApi(product).catch(()=>null);
    if (serpData) return res.json(serpData);
    return res.status(500).json({ error: err.message });
  }
}

export { handleMarket };
