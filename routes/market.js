// routes/market.js — DEXAN Backend v6.0
// API ML real: domain_discovery + highlights + products/items + reviews + seller + peso/dim + visitas

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

// Extrair peso/dimensão dos atributos do produto
function extractPesoFromAttributes(attrs = []) {
  const pesoAttr = attrs.find(a => a.name?.toLowerCase().includes('peso') || a.id === 'WEIGHT');
  const altAttr  = attrs.find(a => a.name?.toLowerCase().includes('altura') || a.id === 'HEIGHT');
  const largAttr = attrs.find(a => a.name?.toLowerCase().includes('largura') || a.id === 'WIDTH');
  const compAttr = attrs.find(a => a.name?.toLowerCase().includes('comprimento') || a.id === 'LENGTH');

  const parseVal = (attr) => {
    if (!attr) return null;
    const match = attr.value_name?.match(/([\d.,]+)/);
    return match ? parseFloat(match[1].replace(',', '.')) : null;
  };

  const pesoKg  = parseVal(pesoAttr);
  const altCm   = parseVal(altAttr);
  const largCm  = parseVal(largAttr);
  const compCm  = parseVal(compAttr);

  // Classificação operacional DEXAN
  let categoriaOperacional = 'desconhecido';
  if (pesoKg !== null) {
    if (pesoKg <= 0.5)      categoriaOperacional = 'mini';     // ideal - PAC até R$15
    else if (pesoKg <= 1.5) categoriaOperacional = 'leve';     // bom  - PAC até R$25
    else if (pesoKg <= 5)   categoriaOperacional = 'medio';    // ok   - R$30-60
    else                    categoriaOperacional = 'pesado';   // ruim - R$60+
  }

  return { pesoKg, altCm, largCm, compCm, categoriaOperacional };
}

// Estimativa de vendas/mês via visitas (conversão ~2-5%)
function estimarVendasMes(visitasMes, totalReviews) {
  if (!visitasMes && !totalReviews) return null;
  if (visitasMes) {
    // Taxa de conversão típica ML: 2-4%
    const estimativaMin = Math.round(visitasMes * 0.02);
    const estimativaMax = Math.round(visitasMes * 0.04);
    return { visitasMes, estimativaMin, estimativaMax, fonte: 'visitas_reais' };
  }
  // Proxy: reviews acumuladas / 12 meses (estimativa conservadora)
  if (totalReviews) {
    const estimativa = Math.round(totalReviews / 12);
    return { estimativa, fonte: 'reviews_proxy' };
  }
  return null;
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
    categoryId ? mlFetchSafe(`https://api.mercadolibre.com/categories/${categoryId}`) : null,
    categoryId ? mlFetchSafe(`https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`) : null
  ]);
  const totalAnuncios = catData?.total_items_in_this_category || null;

  // 3. Top produtos do catálogo (highlights)
  const productIds = (hlData?.content || [])
    .filter(c => c.type === 'PRODUCT' && c.id?.startsWith('MLB') && !c.id.startsWith('MLBU'))
    .map(c => c.id)
    .slice(0, 6);

  // 4. Buscar item vencedor de cada produto
  const productItemsRaw = await Promise.all(
    productIds.map(pid => mlFetchSafe(`https://api.mercadolibre.com/products/${pid}/items?limit=1`))
  );
  const itemDataList = productItemsRaw
    .filter(d => d?.results?.length > 0)
    .map(d => d.results[0]);

  // 5. DADOS COMPLETOS DO LÍDER (primeiro da lista)
  const liderItem = itemDataList[0] || null;
  const liderProdId = productIds[0] || null;

  // 5a. Reviews + rating do líder
  const liderReviews = liderItem ? await mlFetchSafe(
    `https://api.mercadolibre.com/reviews/item/${liderItem.item_id}`
  ) : null;

  // 5b. Visitas 30 dias do líder (estimativa de vendas/mês)
  const liderVisitas = liderItem ? await mlFetchSafe(
    `https://api.mercadolibre.com/items/${liderItem.item_id}/visits/time_window?last=30&unit=day`
  ) : null;

  // 5c. Atributos do produto (peso, dimensões) do produto catálogo líder
  const liderProdDetails = liderProdId ? await mlFetchSafe(
    `https://api.mercadolibre.com/products/${liderProdId}?fields=id,name,attributes`
  ) : null;

  // 5d. Seller do líder
  const liderSellerId = liderItem?.seller_id;
  const liderSeller = liderSellerId ? await mlFetchSafe(
    `https://api.mercadolibre.com/users/${liderSellerId}?attributes=id,nickname,seller_reputation`
  ) : null;

  // 6. Reviews dos demais sellers em paralelo
  const itemIds = itemDataList.map(i => i.item_id).filter(Boolean);
  const reviewsData = await Promise.all(
    itemIds.map(iid => mlFetchSafe(`https://api.mercadolibre.com/reviews/item/${iid}`))
  );

  // 7. Seller reputation dos demais
  const sellerIds = [...new Set(itemDataList.map(i => i.seller_id).filter(Boolean))];
  const sellerData = await Promise.all(
    sellerIds.map(sid => mlFetchSafe(`https://api.mercadolibre.com/users/${sid}?attributes=id,nickname,seller_reputation`))
  );
  const sellerMap = {};
  sellerData.filter(Boolean).forEach(s => { if (s.id) sellerMap[s.id] = s; });

  // 8. Títulos dos produtos de catálogo
  const prodDetails = await Promise.all(
    productIds.map(pid => mlFetchSafe(`https://api.mercadolibre.com/products/${pid}?fields=id,name,attributes`))
  );

  // 9. Montar items
  const items = itemDataList.map((item, idx) => {
    const reviews = reviewsData[idx];
    const seller  = sellerMap[item.seller_id] || (idx === 0 ? liderSeller : null);
    const prod    = prodDetails[idx];
    const pesoInfo = extractPesoFromAttributes(prod?.attributes || []);

    return {
      id:             item.item_id,
      title:          prod?.name || null,
      price:          item.price,
      originalPrice:  item.original_price,
      soldQuantity:   null,
      totalReviews:   reviews?.paging?.total || null,
      ratingAvg:      reviews?.rating_average || null,
      sellerTotalVendas: seller?.seller_reputation?.transactions?.total || null,
      sellerLevel:    seller?.seller_reputation?.level_id || null,
      sellerNickname: seller?.nickname || null,
      freeShipping:   item.shipping?.free_shipping || false,
      fulfillment:    item.shipping?.logistic_type === 'fulfillment',
      condition:      item.condition,
      pesoKg:         pesoInfo.pesoKg,
      categoriaOperacional: pesoInfo.categoriaOperacional,
      link:           `https://www.mercadolivre.com.br/p/${productIds[idx] || item.item_id}`
    };
  });

  // 10. Dados do LÍDER (extra)
  const liderPeso = extractPesoFromAttributes(liderProdDetails?.attributes || []);
  const liderVendasEstimada = estimarVendasMes(
    liderVisitas?.total_visits || null,
    liderReviews?.paging?.total || null
  );
  const liderRating = liderReviews?.rating_average || null;
  const liderTotalReviews = liderReviews?.paging?.total || null;

  // 11. Métricas gerais
  const precos = items.map(i => i.price).filter(p => p != null && p > 0 && p < 100000);
  const avgPreco = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  const freteCount = items.filter(i => i.freeShipping).length;
  const freeShippingPct = items.length ? Math.round((freteCount/items.length)*100) : 0;
  const maxReviews = Math.max(...items.map(i => i.totalReviews || 0).filter(v => v > 0), 0) || null;

  const topSellers = [...items]
    .sort((a,b) => (b.totalReviews||0) - (a.totalReviews||0))
    .slice(0, 6);

  return {
    source: 'ml_api_v6',
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
    maxVendidosMes: null,
    maxReviews,

    // ── DADOS DO LÍDER (para preencher Metrify automaticamente) ──
    lider: {
      titulo:          items[0]?.title || null,
      preco:           items[0]?.price || null,
      ratingAvg:       liderRating,           // ⭐ avaliação real
      totalReviews:    liderTotalReviews,
      visitasMes:      liderVisitas?.total_visits || null,
      vendasEstimada:  liderVendasEstimada,   // 📦 vendas/mês estimadas
      pesoKg:          liderPeso.pesoKg,      // ⚖️ peso real do produto
      categoriaOp:     liderPeso.categoriaOperacional, // mini/leve/medio/pesado
      fulfillment:     items[0]?.fulfillment || false,
      sellerNickname:  items[0]?.sellerNickname || null,
      sellerLevel:     items[0]?.sellerLevel || null,
      sellerVendas:    items[0]?.sellerTotalVendas || null,
    },

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
    source: 'serpapi_fallback', query: product, totalItems: null,
    prices: avg ? { avg: +avg.toFixed(2), min: Math.min(...precos), max: Math.max(...precos) } : null,
    freeShippingPct: 0, maxVendidosMes: null, maxReviews: null, lider: null,
    topSellers: results.slice(0,5).map(r=>({
      title: r.title, price: parseFloat(r.price?.replace(/[R$\s.]/g,'').replace(',','.')) || null,
      soldQuantity: null, totalReviews: null, freeShipping: false, rating: r.rating || null
    }))
  };
}

export async function handleMarket(req, res) {
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
