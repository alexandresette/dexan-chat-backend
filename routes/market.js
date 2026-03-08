// routes/market.js — DEXAN Backend v7.4
// Busca keyword EXATA: varre 700 produtos do catálogo ML em paralelo
// Coleta ~25-40 items com buy_box ativo e métricas estilo Metrify

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
  const d = await resp.json();
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 300) * 1000;
  return cachedToken;
}

async function mlFetch(url) {
  const t = await getMLToken();
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`ML ${resp.status}`);
  return resp.json();
}
const mlSafe = async (url) => { try { return await mlFetch(url); } catch { return null; } };

// Executar tasks em paralelo com limite de concorrência
async function pAll(tasks, concurrency = 20) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
    results.push(...batch);
  }
  return results;
}

async function fetchMarketData(product) {
  await getMLToken();
  const q = encodeURIComponent(product);
  console.log(`Analisando: "${product}"`);

  // ── FASE 1: Dados base em paralelo (domain + total + 14 páginas de catálogo) ──
  const offsets = Array.from({ length: 14 }, (_, i) => i * 50); // 0,50,...,650

  const [dd, totalPage, ...pageResults] = await Promise.all([
    mlSafe(`https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${q}&limit=5`),
    mlSafe(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${q}&limit=1`),
    ...offsets.map(o => mlSafe(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${q}&limit=50&offset=${o}`))
  ]);

  const categories = (dd || []).map(d => ({ id: d.category_id, name: d.category_name, domain: d.domain_id }));
  const mainCat = categories[0] || { id: null, name: product, domain: null };
  const totalBuscaExata = totalPage?.paging?.total || null;

  // Coletar todos os product_ids
  const allPids = [];
  const seen = new Set();
  for (const page of pageResults) {
    for (const r of page?.results || []) {
      if (!seen.has(r.id)) { seen.add(r.id); allPids.push(r.id); }
    }
  }

  console.log(`Total exato: ${totalBuscaExata} | Produtos varredura: ${allPids.length}`);

  // ── FASE 2: Dados da categoria + highlights em paralelo ──
  const [catData, ...hlData] = await Promise.all([
    mainCat.id ? mlSafe(`https://api.mercadolibre.com/categories/${mainCat.id}`) : Promise.resolve(null),
    ...categories.slice(0, 3).map(c => mlSafe(`https://api.mercadolibre.com/highlights/MLB/category/${c.id}`))
  ]);

  const totalNaCategoria = catData?.total_items_in_this_category || null;

  // Product IDs dos highlights
  const hlPids = [];
  for (const hl of hlData) {
    for (const c of hl?.content || []) {
      if (c.type === 'PRODUCT' && c.id && !hlPids.includes(c.id)) hlPids.push(c.id);
    }
  }

  // ── FASE 3: Items + nomes em paralelo (todos os pids de uma vez) ──
  const allProductPids = [...new Set([...hlPids, ...allPids])]; // highlights primeiro

  const fetchItemAndName = async (pid) => {
    const [itemD, nameD] = await Promise.all([
      mlSafe(`https://api.mercadolibre.com/products/${pid}/items?limit=1`),
      mlSafe(`https://api.mercadolibre.com/products/${pid}?fields=id,name`)
    ]);
    if (!itemD?.results?.length) return null;
    const item = itemD.results[0];
    return {
      pid,
      item_id: item.item_id,
      name: nameD?.name || null,
      price: item.price,
      original_price: item.original_price || null,
      seller_id: item.seller_id,
      official_store_id: item.official_store_id,
      listing_type_id: item.listing_type_id,
      shipping: item.shipping || {},
      international: item.international_delivery_mode,
      condition: item.condition,
      isHighlight: hlPids.includes(pid)
    };
  };

  const rawItems = await pAll(allProductPids.map(pid => () => fetchItemAndName(pid)), 20);
  const allItems = rawItems.filter(Boolean);

  console.log(`Items com dados: ${allItems.length}/${allProductPids.length}`);

  // ── FASE 4: Reputação dos top 5 sellers ──
  const sellerAccum = {};
  for (const i of allItems) {
    const sid = i.seller_id;
    if (!sid) continue;
    if (!sellerAccum[sid]) sellerAccum[sid] = { count: 0, soma: 0, topItem: null, sid };
    sellerAccum[sid].count++;
    sellerAccum[sid].soma += i.price || 0;
    if (!sellerAccum[sid].topItem) sellerAccum[sid].topItem = i;
  }

  const top5sids = Object.values(sellerAccum).sort((a,b) => b.soma - a.soma).slice(0,5).map(s=>s.sid);
  const sellerDetails = await pAll(
    top5sids.map(sid => () => mlSafe(`https://api.mercadolibre.com/users/${sid}?attributes=id,nickname,seller_reputation`)),
    5
  );

  // ── Cálculo de métricas ──
  const n = allItems.length || 1;
  let full=0, frete=0, ofic=0, promo=0, intl=0, mlLider=0;
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

  // ML Líder: verificar via seller_reputation.power_seller_status
  for (const d of sellerDetails) {
    const ps = d?.seller_reputation?.power_seller_status;
    if (ps && ps !== 'none' && ps !== null) mlLider++;
  }

  const topSellers = top5sids.map((sid, idx) => {
    const s = sellerAccum[sid];
    const d = sellerDetails[idx];
    const rep = d?.seller_reputation || {};
    return {
      sellerNickname: d?.nickname || `Seller ${sid}`,
      sellerLevel: rep.level_id || null,
      powerStatus: rep.power_seller_status || null,
      totalVendasHistorico: rep.transactions?.total || null,
      anunciosNaAmostra: s.count,
      faturamentoAmostra: +s.soma.toFixed(2),
      topItem: s.topItem ? {
        id: s.topItem.item_id,
        title: s.topItem.name,
        price: s.topItem.price,
        freeShipping: s.topItem.shipping?.free_shipping || false,
        fulfillment: s.topItem.shipping?.logistic_type === 'fulfillment',
        originalPrice: s.topItem.original_price || null,
        listingType: s.topItem.listing_type_id
      } : null
    };
  });

  const melhoresAnuncios = [...allItems]
    .filter(i => i.price > 0)
    .sort((a,b) => (b.isHighlight?1:0)-(a.isHighlight?1:0) || b.price-a.price)
    .slice(0,10)
    .map(i => ({
      id: i.item_id || i.pid,
      title: i.name,
      price: i.price,
      originalPrice: i.original_price,
      freeShipping: i.shipping?.free_shipping || false,
      fulfillment: i.shipping?.logistic_type === 'fulfillment',
      condition: i.condition,
      isOficial: !!i.official_store_id,
      isPromocao: !!(i.original_price && i.original_price > i.price),
      isInternacional: !!(i.international && i.international !== 'none'),
      listingType: i.listing_type_id
    }));

  const precoMedio = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;

  return {
    source: 'ml_api_v7',
    query: product,
    categoriaNome: mainCat.name || product,
    categoriaId: mainCat.id,
    dominioNome: mainCat.domain,
    itemsAnalisados: allItems.length,

    totalAnuncios: totalBuscaExata,
    totalNaCategoria,

    totalLojasOficiais: ofic,
    totalFull: full,
    totalFreteGratis: frete,
    totalMercadoLideres: mlLider,
    totalInternacional: intl,
    totalPromocao: promo,
    totalSellers: sellerIds.size,

    pctFull:        +(full  /n*100).toFixed(1),
    pctFreteGratis: +(frete /n*100).toFixed(1),
    pctPromocao:    +(promo /n*100).toFixed(1),
    pctOficiais:    +(ofic  /n*100).toFixed(1),

    precoMedio:     precoMedio ? +precoMedio.toFixed(2) : null,
    precoMedioP1:   precoMedio ? +precoMedio.toFixed(2) : null,
    precoMin:       precos.length ? +Math.min(...precos).toFixed(2) : null,
    precoMax:       precos.length ? +Math.max(...precos).toFixed(2) : null,
    mercadoEnderecavel: precos.length ? +precos.reduce((a,b)=>a+b,0).toFixed(2) : null,

    topSellers,
    melhoresAnuncios
  };
}

export async function handleMarket(req, res) {
  const { product, source } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product obrigatório' });
  // aceita source='mercadolivre' do frontend v8, ou sem source (retrocompat v7)
  try {
    const data = await fetchMarketData(product);
    // aliases para compatibilidade com frontend v8
    data.totalAnuncios = data.totalAnuncios || data.totalBuscaExata;
    data.totalLojasOficiais = data.totalLojasOficiais || data.totalOficiais;
    data.totalFreteGratis = data.totalFreteGratis || data.totalFrete;
    data.pctLojasOficiais = data.pctLojasOficiais || data.pctOficiais;
    data.pctFreteGratis = data.pctFreteGratis || data.pctFreteGratis;
    data.totalMercadoLideres = data.totalMercadoLideres || data.totalMlLider || 0;
    data.pctLideres = data.pctLideres || 0;
    data.totalInternacional = data.totalInternacional || 0;
    data.pctInternacional = data.pctInternacional || 0;
    data.totalPromocao1aPagina = data.totalPromocao1aPagina || data.totalPromocao || 0;
    data.pctPromocao1aPagina = data.pctPromocao1aPagina || data.pctPromocao || 0;
    data.precoMedio = data.precoMedio || data.precoMedioP1;
    data.mercadoEndereçavel = data.mercadoEndereçavel || data.mercadoEnderecavel;
    data.topAnuncios = data.topAnuncios || data.melhoresAnuncios || [];
    return res.json(data);
  } catch(err) {
    console.error('Market error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
