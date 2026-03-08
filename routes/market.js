// routes/market.js — DEXAN Backend v10
// Usa token OAuth de usuário (salvo pelo auth-callback) → /sites/MLB/search
// Fallback: token client_credentials → /products/search (se OAuth não disponível)

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

// ─── Token client_credentials (fallback) ─────────────────────────────────────
let _appToken = null;
let _appTokenExpiry = 0;

async function getAppToken() {
  if (_appToken && Date.now() < _appTokenExpiry) return _appToken;
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
  });
  if (!resp.ok) throw new Error('Falha token ML: ' + resp.status);
  const d = await resp.json();
  _appToken = d.access_token;
  _appTokenExpiry = Date.now() + (d.expires_in - 300) * 1000;
  console.log('Token app (client_credentials) renovado');
  return _appToken;
}

// ─── Token OAuth de usuário (principal) ──────────────────────────────────────
function getUserToken() {
  if (global._mlUserToken && Date.now() < global._mlUserTokenExpiry) {
    return global._mlUserToken;
  }
  return null;
}

// ─── Fetch ML com token ───────────────────────────────────────────────────────
async function mlFetch(url, useUserToken = true) {
  const token = (useUserToken && getUserToken()) ? getUserToken() : await getAppToken();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  return { status: resp.status, data: await resp.json() };
}

const mlSafe = async (url, useUserToken = true) => {
  try {
    const r = await mlFetch(url, useUserToken);
    return r.status === 200 ? r.data : null;
  } catch { return null; }
};

// ─── Executor paralelo com limite de concorrência ────────────────────────────
async function pAll(tasks, concurrency = 20) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
    results.push(...batch);
  }
  return results;
}

// ─── Handler exportado ────────────────────────────────────────────────────────
export async function handleMarket(req, res) {
  const { product, source } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product obrigatório' });

  try {
    const hasUserToken = !!getUserToken();
    console.log(`Busca "${product}" — token: ${hasUserToken ? 'OAuth usuário ✅' : 'client_credentials ⚠️'}`);

    let data;
    try {
      // Tenta sempre o /sites/MLB/search com OAuth (se disponível) ou client_credentials
      data = hasUserToken
        ? await fetchWithUserToken(product)
        : await fetchWithAppToken(product);
    } catch(primaryErr) {
      // Se /sites/MLB/search bloqueado (403 IP cloud) → fallback garantido para /products/search
      console.warn('Modo principal falhou, ativando fallback /products/search:', primaryErr.message);
      data = await fetchWithAppToken(product);
    }

    return res.json(data);
  } catch(err) {
    console.error('Market error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── MODO PRINCIPAL: OAuth → /sites/MLB/search (igual Metrify) ───────────────
async function fetchWithUserToken(product) {
  const q = encodeURIComponent(product);
  const base = `https://api.mercadolibre.com/sites/MLB/search?q=${q}`;

  // Busca principal com available_filters
  const mainR = await mlFetch(`${base}&limit=50&sort=relevance`, true);
  if (mainR.status !== 200) throw new Error(`MLB/search ${mainR.status}: ${JSON.stringify(mainR.data).substring(0,150)}`);

  const main = mainR.data;

  // Preço min/max em paralelo
  const [minR, maxR] = await Promise.allSettled([
    mlFetch(`${base}&limit=1&sort=price_asc`, true),
    mlFetch(`${base}&limit=1&sort=price_desc`, true)
  ]);

  const items     = main.results || [];
  const paging    = main.paging  || {};
  const avFilters = main.available_filters || [];
  const totalReal = paging.total || items.length;

  console.log(`Total real /sites/MLB/search: ${totalReal} | Filtros: ${avFilters.length}`);

  // Totais via available_filters — catálogo completo
  const getF = (id) => {
    const f = avFilters.find(x => x.id === id);
    return f ? { total: f.values.reduce((a,v) => a+(v.results||0), 0), values: f.values } : { total: 0, values: [] };
  };

  const fullVals   = getF('fulfillment');
  const totalFull  = fullVals.values.find(v => v.id === 'fulfillment')?.results || 0;

  const freteVals  = getF('free_shipping');
  const totalFrete = freteVals.values.find(v => v.id === 'yes')?.results || 0;

  const oficVals   = getF('official_store');
  const totalOfic  = oficVals.total;

  const liderVals  = getF('power_seller_status');
  const totalLider = liderVals.values.reduce((a,v) =>
    ['platinum','gold'].includes(v.id) ? a+(v.results||0) : a, 0);

  const intlVals   = getF('item_location');
  const totalIntl  = intlVals.values.filter(v => v.id !== 'BR').reduce((a,v) => a+(v.results||0), 0);

  const sellers = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalPromocao = items.filter(i => i.original_price && i.original_price > i.price).length;

  const prices  = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 500000);
  const avgPrice = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;

  let minPrice = prices.length ? Math.min(...prices) : 0;
  if (minR.status==='fulfilled' && minR.value?.data?.results?.[0]?.price)
    minPrice = parseFloat(minR.value.data.results[0].price);

  let maxPrice = prices.length ? Math.max(...prices) : 0;
  if (maxR.status==='fulfilled' && maxR.value?.data?.results?.[0]?.price) {
    const c = parseFloat(maxR.value.data.results[0].price);
    if (c < 1000000) maxPrice = c;
  }

  const topAnuncios = items.slice(0,10).map(i => ({
    id:            i.id,
    title:         i.title,
    price:         parseFloat(i.price),
    originalPrice: i.original_price ? parseFloat(i.original_price) : null,
    soldQuantity:  i.sold_quantity || 0,
    freeShipping:  i.shipping?.free_shipping || false,
    fulfillment:   i.shipping?.logistic_type === 'fulfillment',
    isOficial:     !!i.official_store_id,
    isPromocao:    !!(i.original_price && i.original_price > i.price),
    condition:     i.condition,
    thumbnail:     i.thumbnail,
    link:          i.permalink,
    seller: { id: i.seller?.id, nickname: i.seller?.nickname, level: i.seller?.seller_reputation?.level_id }
  }));

  return {
    source: 'ml_oauth_v10',
    query:  product,
    tokenType: 'user_oauth',

    totalAnuncios:       totalReal,
    totalLojasOficiais:  totalOfic,
    totalFull,
    totalFreteGratis:    totalFrete,
    totalMercadoLideres: totalLider,
    totalInternacional:  totalIntl,
    totalSellers:        sellers.size,

    pctLojasOficiais: totalReal > 0 ? +((totalOfic  /totalReal)*100).toFixed(1) : 0,
    pctFull:          totalReal > 0 ? +((totalFull  /totalReal)*100).toFixed(1) : 0,
    pctFreteGratis:   totalReal > 0 ? +((totalFrete /totalReal)*100).toFixed(1) : 0,
    pctLideres:       totalReal > 0 ? +((totalLider /totalReal)*100).toFixed(1) : 0,
    pctInternacional: totalReal > 0 ? +((totalIntl  /totalReal)*100).toFixed(1) : 0,

    totalPromocao1aPagina: totalPromocao,
    pctPromocao1aPagina:   items.length > 0 ? +((totalPromocao/items.length)*100).toFixed(1) : 0,

    precoMedio:          avgPrice,
    precoMin:            +minPrice.toFixed(2),
    precoMax:            +maxPrice.toFixed(2),
    mercadoEndereçavel:  +(avgPrice * totalReal).toFixed(2),

    topAnuncios,
  };
}

// ─── FALLBACK: client_credentials → /products/search ─────────────────────────
async function fetchWithAppToken(product) {
  const q = encodeURIComponent(product);
  const offsets = Array.from({ length: 14 }, (_, i) => i * 50);

  const [dd, totalPage, ...pageResults] = await Promise.all([
    mlSafe(`https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${q}&limit=5`, false),
    mlSafe(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${q}&limit=1`, false),
    ...offsets.map(o => mlSafe(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${q}&limit=50&offset=${o}`, false))
  ]);

  const categories = (dd || []).map(d => ({ id: d.category_id, name: d.category_name, domain: d.domain_id }));
  const mainCat = categories[0] || { id: null, name: product };
  const totalBuscaExata = totalPage?.paging?.total || null;

  const allPids = [];
  const seen = new Set();
  for (const page of pageResults) {
    for (const r of page?.results || []) {
      if (!seen.has(r.id)) { seen.add(r.id); allPids.push(r.id); }
    }
  }

  const [catData, ...hlData] = await Promise.all([
    mainCat.id ? mlSafe(`https://api.mercadolibre.com/categories/${mainCat.id}`, false) : Promise.resolve(null),
    ...categories.slice(0,3).map(c => mlSafe(`https://api.mercadolibre.com/highlights/MLB/category/${c.id}`, false))
  ]);

  const hlPids = [];
  for (const hl of hlData) {
    for (const c of hl?.content || []) {
      if (c.type === 'PRODUCT' && c.id && !hlPids.includes(c.id)) hlPids.push(c.id);
    }
  }

  const allProductPids = [...new Set([...hlPids, ...allPids])];

  const rawItems = await pAll(allProductPids.map(pid => async () => {
    const [itemD, nameD] = await Promise.all([
      mlSafe(`https://api.mercadolibre.com/products/${pid}/items?limit=1`, false),
      mlSafe(`https://api.mercadolibre.com/products/${pid}?fields=id,name`, false)
    ]);
    if (!itemD?.results?.length) return null;
    const item = itemD.results[0];
    return { pid, item_id: item.item_id, name: nameD?.name || null, price: item.price,
      original_price: item.original_price || null, seller_id: item.seller_id,
      official_store_id: item.official_store_id, shipping: item.shipping || {},
      international: item.international_delivery_mode, condition: item.condition, isHighlight: hlPids.includes(pid) };
  }), 20);

  const allItems = rawItems.filter(Boolean);
  const n = allItems.length || 1;
  let full=0, frete=0, ofic=0, promo=0, intl=0;
  const precos = [], sellerIds = new Set();
  for (const i of allItems) {
    const p = i.price || 0;
    if (p > 0 && p < 500000) precos.push(p);
    if (i.shipping?.logistic_type === 'fulfillment') full++;
    if (i.shipping?.free_shipping) frete++;
    if (i.official_store_id) ofic++;
    if (i.original_price && i.original_price > i.price) promo++;
    if (i.international && i.international !== 'none') intl++;
    if (i.seller_id) sellerIds.add(i.seller_id);
  }

  const precoMedio = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;

  const melhoresAnuncios = allItems.slice(0,10).map(i => ({
    id: i.item_id, title: i.name, price: i.price, originalPrice: i.original_price,
    freeShipping: i.shipping?.free_shipping || false, fulfillment: i.shipping?.logistic_type === 'fulfillment',
    condition: i.condition, isOficial: !!i.official_store_id,
    isPromocao: !!(i.original_price && i.original_price > i.price),
  }));

  return {
    source: 'ml_app_v10_fallback',
    query: product,
    tokenType: 'client_credentials',
    totalAnuncios: totalBuscaExata,
    totalLojasOficiais: ofic, totalFull: full, totalFreteGratis: frete,
    totalMercadoLideres: 0, totalInternacional: intl, totalSellers: sellerIds.size,
    pctLojasOficiais: +((ofic/n)*100).toFixed(1), pctFull: +((full/n)*100).toFixed(1),
    pctFreteGratis: +((frete/n)*100).toFixed(1), pctLideres: 0, pctInternacional: +((intl/n)*100).toFixed(1),
    totalPromocao1aPagina: promo, pctPromocao1aPagina: +((promo/n)*100).toFixed(1),
    precoMedio: precoMedio ? +precoMedio.toFixed(2) : null,
    precoMin: precos.length ? +Math.min(...precos).toFixed(2) : null,
    precoMax: precos.length ? +Math.max(...precos).toFixed(2) : null,
    mercadoEndereçavel: precos.length ? +(precos.reduce((a,b)=>a+b,0)).toFixed(2) : null,
    topAnuncios: melhoresAnuncios,
  };
}
