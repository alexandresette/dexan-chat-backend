// routes/market.js — DEXAN Backend v7.2
// Mesma abordagem do v5/v6 que funcionava (domain_discovery + highlights + products/items)
// NOVO: busca em MÚLTIPLAS categorias + /products/search para mais abrangência

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

// Busca em paralelo com limite de concorrência
async function parallelFetch(urls, concurrency = 10) {
  const results = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(url => mlFetchSafe(url)));
    results.push(...batchResults);
    if (i + concurrency < urls.length) await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

async function fetchMarketData(product) {
  const token = await getMLToken();
  console.log(`Analisando: "${product}"`);

  // ── 1. Domain discovery: pegar TODAS as categorias relacionadas à keyword ──
  const dd = await mlFetchSafe(
    `https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${encodeURIComponent(product)}&limit=10`
  );
  const categories = (dd || []).map(d => ({
    id: d.category_id,
    name: d.category_name,
    domain: d.domain_id
  }));
  
  // Categoria principal (primeira)
  const mainCat = categories[0] || { id: null, name: product, domain: null };
  console.log(`Categorias encontradas: ${categories.map(c => c.name).join(', ')}`);

  // ── 2. Dados de cada categoria em paralelo ──
  const [catDataList, hlDataList, psData] = await Promise.all([
    // Total de itens em cada categoria
    Promise.all(categories.slice(0,3).map(c =>
      mlFetchSafe(`https://api.mercadolibre.com/categories/${c.id}`)
    )),
    // Highlights de cada categoria
    Promise.all(categories.slice(0,3).map(c =>
      mlFetchSafe(`https://api.mercadolibre.com/highlights/MLB/category/${c.id}`)
    )),
    // Busca de produtos de catálogo com keyword EXATA (paginação: 4 páginas de 50)
    Promise.all([0, 50, 100, 150].map(offset =>
      mlFetchSafe(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${encodeURIComponent(product)}&limit=50&offset=${offset}`)
    ))
  ]);

  // Total de resultados da busca keyword exata (do /products/search)
  const totalBuscaExata = psData[0]?.paging?.total || null;

  // Total de itens na categoria principal
  const totalNaCategoria = catDataList[0]?.total_items_in_this_category || null;

  // ── 3. Coletar IDs dos highlights (PRODUCT e ITEM types) ──
  const highlightIds = [];
  for (const hl of hlDataList) {
    if (!hl) continue;
    for (const c of (hl.content || [])) {
      if (c.id && !highlightIds.includes(c.id)) {
        highlightIds.push({ id: c.id, type: c.type });
      }
    }
  }

  // ── 4. Produtos de catálogo do /products/search ──
  const catalogProducts = [];
  for (const page of psData) {
    if (page?.results) catalogProducts.push(...page.results);
  }
  const catalogProductIds = catalogProducts.map(p => p.id);

  console.log(`Highlights: ${highlightIds.length} | Catálogo: ${catalogProductIds.length}`);

  // ── 5. Buscar items de todos os produtos de catálogo em paralelo ──
  // (mesmo que só ~12% tenham buy_box, coletamos o máximo possível)
  const productItemUrls = catalogProductIds.slice(0, 100).map(pid =>
    `https://api.mercadolibre.com/products/${pid}/items?limit=3`
  );
  const productItemsRaw = await parallelFetch(productItemUrls, 15);
  
  const itemsFromCatalog = [];
  for (const d of productItemsRaw) {
    if (d?.results?.length > 0) itemsFromCatalog.push(...d.results);
  }

  // ── 6. Buscar itens diretos dos highlights (tipo ITEM) ──
  const itemTypeIds = highlightIds.filter(h => h.type === 'ITEM').map(h => h.id);
  const productTypeIds = highlightIds.filter(h => h.type === 'PRODUCT').map(h => h.id);

  const [itemDirectData, productItemData] = await Promise.all([
    // Itens diretos (têm todos os dados: preço, frete, seller)
    parallelFetch(itemTypeIds.slice(0, 20).map(id =>
      `https://api.mercadolibre.com/items/${id}`
    ), 10),
    // Produtos de catálogo dos highlights
    parallelFetch(productTypeIds.slice(0, 20).map(pid =>
      `https://api.mercadolibre.com/products/${pid}/items?limit=1`
    ), 10)
  ]);

  const itemsFromHighlightDirect = itemDirectData.filter(Boolean);
  const itemsFromHighlightProducts = productItemData.flatMap(d => d?.results || []).filter(Boolean);

  // ── 7. Consolidar TODOS os items com dados ──
  const allItems = [
    ...itemsFromCatalog,
    ...itemsFromHighlightProducts,
    ...itemsFromHighlightDirect.map(d => ({
      item_id: d.id,
      price: d.price,
      original_price: d.original_price,
      seller_id: d.seller_id,
      official_store_id: d.official_store_id,
      listing_type_id: d.listing_type_id,
      shipping: d.shipping,
      international_delivery_mode: d.international_delivery_mode,
      condition: d.condition,
      title: d.title,
      thumbnail: d.thumbnail,
      permalink: d.permalink
    }))
  ];

  // Deduplicar por item_id
  const seenIds = new Set();
  const uniqueItems = allItems.filter(i => {
    const id = i.item_id || i.id;
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  console.log(`Items com dados completos: ${uniqueItems.length}`);

  // ── 8. Calcular métricas ──
  let totalFull = 0, totalFrete = 0, totalOficiais = 0, totalPromo = 0;
  let totalIntl = 0, totalMlLideres = 0;
  const precos = [], sellerIds = new Set(), sellerMap = {};

  for (const item of uniqueItems) {
    const preco = item.price || 0;
    if (preco > 0 && preco < 500000) precos.push(preco);

    const logistic = item.shipping?.logistic_type || '';
    if (logistic === 'fulfillment') totalFull++;
    if (item.shipping?.free_shipping) totalFrete++;
    if (item.official_store_id) totalOficiais++;
    if (item.original_price && item.original_price > item.price) totalPromo++;
    if (item.international_delivery_mode && item.international_delivery_mode !== 'none') totalIntl++;

    // Gold listing = ML Líder (gold_pro = Platinum, gold_special = Ouro)
    const lt = item.listing_type_id || '';
    if (lt.includes('gold')) totalMlLideres++;

    const sid = item.seller_id;
    if (sid) {
      sellerIds.add(sid);
      if (!sellerMap[sid]) sellerMap[sid] = { count: 0, somaPrecos: 0, topItem: null, sid };
      sellerMap[sid].count++;
      sellerMap[sid].somaPrecos += preco;
      if (!sellerMap[sid].topItem) sellerMap[sid].topItem = item;
    }
  }

  // ── 9. Sellers: pegar reputação dos top 5 ──
  const topSellerIds = Object.values(sellerMap)
    .sort((a,b) => b.somaPrecos - a.somaPrecos)
    .slice(0, 5)
    .map(s => s.sid);

  const sellerDetails = await parallelFetch(
    topSellerIds.map(sid => `https://api.mercadolibre.com/users/${sid}?attributes=id,nickname,seller_reputation`),
    5
  );

  const topSellers = topSellerIds.map((sid, i) => {
    const s = sellerMap[sid];
    const details = sellerDetails[i];
    const item = s.topItem;
    const nivel = details?.seller_reputation?.level_id || null;
    const power = details?.seller_reputation?.power_seller_status || null;
    const totalVendas = details?.seller_reputation?.transactions?.total || null;
    return {
      sellerNickname: details?.nickname || `Seller ${sid}`,
      sellerLevel: nivel,
      powerStatus: power,
      totalVendasHistorico: totalVendas,
      anunciosNaAmostra: s.count,
      faturamentoAmostra: +s.somaPrecos.toFixed(2),
      topItem: item ? {
        id: item.item_id || item.id,
        title: item.title || null,
        price: item.price,
        freeShipping: item.shipping?.free_shipping || false,
        fulfillment: item.shipping?.logistic_type === 'fulfillment',
        originalPrice: item.original_price || null,
        thumbnail: item.thumbnail || null,
        link: item.permalink || null
      } : null
    };
  });

  // ── 10. Melhores anúncios (top 10 por preço + dados) ──
  const melhoresAnuncios = [...uniqueItems]
    .filter(i => i.price > 0)
    .sort((a,b) => b.price - a.price)
    .slice(0, 10)
    .map(item => ({
      id: item.item_id || item.id,
      title: item.title || null,
      price: item.price,
      originalPrice: item.original_price || null,
      freeShipping: item.shipping?.free_shipping || false,
      fulfillment: item.shipping?.logistic_type === 'fulfillment',
      sellerNickname: sellerMap[item.seller_id]?.topItem?.sellerNickname || null,
      condition: item.condition,
      thumbnail: item.thumbnail || null,
      link: item.permalink || null,
      isOficial: !!(item.official_store_id),
      isPromocao: !!(item.original_price && item.original_price > item.price),
      isInternacional: !!(item.international_delivery_mode && item.international_delivery_mode !== 'none'),
      listingType: item.listing_type_id
    }));

  // ── 11. Métricas finais ──
  const n = uniqueItems.length || 1;
  const precoMedio = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;

  return {
    source: 'ml_api_v7',
    query: product,
    categorias: categories.slice(0, 3).map(c => c.name),
    categoriaId: mainCat.id,
    categoriaNome: mainCat.name,

    // ── MÉTRICAS PRINCIPAIS ──
    totalAnuncios: totalBuscaExata || totalNaCategoria,        // total da busca keyword exata
    totalNaCategoria: totalNaCategoria,                         // total na categoria
    itemsAnalisados: uniqueItems.length,                        // amostra analisada

    totalLojasOficiais: totalOficiais,
    totalFull: totalFull,
    totalFreteGratis: totalFrete,
    totalMercadoLideres: totalMlLideres,
    totalInternacional: totalIntl,
    totalPromocao: totalPromo,
    totalSellers: sellerIds.size,

    // Percentuais (baseados na amostra)
    pctFull: +(totalFull / n * 100).toFixed(1),
    pctFreteGratis: +(totalFrete / n * 100).toFixed(1),
    pctPromocao: +(totalPromo / n * 100).toFixed(1),
    pctOficiais: +(totalOficiais / n * 100).toFixed(1),

    // Preços
    precoMedio: precoMedio ? +precoMedio.toFixed(2) : null,
    precoMedioP1: precoMedio ? +precoMedio.toFixed(2) : null,  // melhor estimativa disponível
    precoMin: precos.length ? +Math.min(...precos).toFixed(2) : null,
    precoMax: precos.length ? +Math.max(...precos).toFixed(2) : null,
    mercadoEnderecavel: precos.length ? +precos.reduce((a,b)=>a+b,0).toFixed(2) : null,

    topSellers,
    melhoresAnuncios
  };
}

export async function handleMarket(req, res) {
  const { product } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product obrigatório' });

  try {
    const data = await fetchMarketData(product);
    return res.json(data);
  } catch(err) {
    console.error('Market error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
