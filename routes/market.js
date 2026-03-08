// routes/market.js — DEXAN Backend v7.3
// Busca keyword EXATA via /products/search + /products/{id}/items
// Coleta até 40+ items com dados reais; métricas estilo Metrify

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

async function mlSafe(url) {
  try { return await mlFetch(url); } catch { return null; }
}

async function parallel(tasks, concurrency = 15) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const res = await Promise.all(batch.map(fn => fn()));
    results.push(...res);
    if (i + concurrency < tasks.length) await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

async function fetchMarketData(product) {
  await getMLToken();
  const q = encodeURIComponent(product);
  console.log(`Analisando: "${product}"`);

  // ── 1. Dados em paralelo: domain_discovery + total exato ──
  const [dd, totalPage] = await Promise.all([
    mlSafe(`https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${q}&limit=5`),
    mlSafe(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${q}&limit=1`)
  ]);

  const categories = (dd || []).map(d => ({ id: d.category_id, name: d.category_name, domain: d.domain_id }));
  const mainCat = categories[0] || { id: null, name: product, domain: null };
  const totalBuscaExata = totalPage?.paging?.total || null;

  console.log(`Cat: ${mainCat.name} | Total catálogo: ${totalBuscaExata}`);

  // ── 2. Dados da categoria + highlights em paralelo ──
  const [catData, hlDataList] = await Promise.all([
    mainCat.id ? mlSafe(`https://api.mercadolibre.com/categories/${mainCat.id}`) : null,
    Promise.all(categories.slice(0, 3).map(c =>
      mlSafe(`https://api.mercadolibre.com/highlights/MLB/category/${c.id}`)
    ))
  ]);

  const totalNaCategoria = catData?.total_items_in_this_category || null;

  // Produtos dos highlights
  const hlProductIds = [];
  for (const hl of hlDataList) {
    if (!hl) continue;
    for (const c of (hl.content || [])) {
      if (c.id && c.type === 'PRODUCT' && !hlProductIds.includes(c.id)) hlProductIds.push(c.id);
    }
  }

  // ── 3. Buscar produtos via /products/search em batches ──
  // Estratégia: buscar em lotes de 200 até ter 40+ items com buy_box ativo
  const allItemsData = [];
  const seenPids = new Set();
  let offset = 0;
  const MAX_ROUNDS = 6; // máx 6 rounds = 1200 produtos varridos
  let round = 0;

  // Primeiro processar os highlights (mais relevantes)
  const hlTasks = hlProductIds.slice(0, 20).map(pid => async () => {
    if (seenPids.has(pid)) return null;
    seenPids.add(pid);
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
      is_highlight: true
    };
  });

  const hlResults = (await parallel(hlTasks, 10)).filter(Boolean);
  allItemsData.push(...hlResults);

  // Agora buscar via /products/search em rounds
  while (allItemsData.length < 40 && round < MAX_ROUNDS) {
    // Buscar 4 páginas de 50 em paralelo
    const pages = await Promise.all([0, 50, 100, 150].map(extra =>
      mlSafe(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${q}&limit=50&offset=${offset + extra}`)
    ));

    const newPids = [];
    for (const p of pages) {
      if (p?.results) {
        for (const r of p.results) {
          if (!seenPids.has(r.id)) {
            seenPids.add(r.id);
            newPids.push(r.id);
          }
        }
      }
    }

    if (newPids.length === 0) break;

    // Buscar items + nomes em paralelo
    const tasks = newPids.map(pid => async () => {
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
        is_highlight: false
      };
    });

    const roundResults = (await parallel(tasks, 15)).filter(Boolean);
    allItemsData.push(...roundResults);

    console.log(`Round ${round + 1}: offset=${offset} | +${roundResults.length} items | total=${allItemsData.length}`);
    offset += 200;
    round++;

    if (roundResults.length === 0 && round > 1) break; // sem mais dados, parar
  }

  const n = allItemsData.length;
  console.log(`Total items com dados: ${n}`);

  // ── 4. Métricas ──
  let totalFull = 0, totalFrete = 0, totalOficiais = 0, totalPromo = 0;
  let totalIntl = 0, totalMlLideres = 0;
  const precos = [], sellerIds = new Set(), sellerAccum = {};

  for (const i of allItemsData) {
    const preco = i.price || 0;
    if (preco > 0 && preco < 500000) precos.push(preco);

    if (i.shipping?.logistic_type === 'fulfillment') totalFull++;
    if (i.shipping?.free_shipping) totalFrete++;
    if (i.official_store_id) totalOficiais++;
    if (i.original_price && i.original_price > i.price) totalPromo++;
    if (i.international && i.international !== 'none') totalIntl++;

    // ML Líder = gold_pro (Platinum) ou gold_special (Ouro)
    // listing_type_id: 'gold_pro', 'gold_special', 'gold_premium', 'gold'
    const lt = i.listing_type_id || '';
    if (lt === 'gold_special' || lt === 'gold_pro') totalMlLideres++;

    const sid = i.seller_id;
    if (sid) {
      sellerIds.add(sid);
      if (!sellerAccum[sid]) sellerAccum[sid] = { count: 0, soma: 0, topItem: null, sid };
      sellerAccum[sid].count++;
      sellerAccum[sid].soma += preco;
      if (!sellerAccum[sid].topItem) sellerAccum[sid].topItem = i;
    }
  }

  // ── 5. Reputação dos top 5 sellers ──
  const topSellerIds = Object.values(sellerAccum)
    .sort((a, b) => b.soma - a.soma)
    .slice(0, 5)
    .map(s => s.sid);

  const sellerDetails = await parallel(
    topSellerIds.map(sid => () => mlSafe(`https://api.mercadolibre.com/users/${sid}?attributes=id,nickname,seller_reputation`)),
    5
  );

  const topSellers = topSellerIds.map((sid, idx) => {
    const s = sellerAccum[sid];
    const d = sellerDetails[idx];
    const rep = d?.seller_reputation || {};
    const item = s.topItem;
    return {
      sellerNickname: d?.nickname || `Vendedor ${sid}`,
      sellerLevel: rep.level_id || null,
      powerStatus: rep.power_seller_status || null,
      totalVendasHistorico: rep.transactions?.total || null,
      anunciosNaAmostra: s.count,
      faturamentoAmostra: +s.soma.toFixed(2),
      topItem: item ? {
        id: item.item_id,
        title: item.name,
        price: item.price,
        freeShipping: item.shipping?.free_shipping || false,
        fulfillment: item.shipping?.logistic_type === 'fulfillment',
        originalPrice: item.original_price || null,
        listingType: item.listing_type_id
      } : null
    };
  });

  // ── 6. Melhores anúncios (da amostra, ordenados por is_highlight → preço) ──
  const melhoresAnuncios = [...allItemsData]
    .filter(i => i.price > 0)
    .sort((a, b) => (b.is_highlight ? 1 : 0) - (a.is_highlight ? 1 : 0) || b.price - a.price)
    .slice(0, 10)
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
      listingType: i.listing_type_id,
      isMLLider: ['gold_pro','gold_special'].includes(i.listing_type_id || '')
    }));

  // ── 7. Retorno ──
  const precoMedio = precos.length ? precos.reduce((a,b)=>a+b,0)/precos.length : null;
  const div = n || 1;

  return {
    source: 'ml_api_v7',
    query: product,
    categoriaNome: mainCat.name,
    categoriaId: mainCat.id,
    dominioNome: mainCat.domain,
    itemsAnalisados: n,

    // Totais reais
    totalAnuncios: totalBuscaExata,       // total de produtos catálogo com essa keyword
    totalNaCategoria,                      // total de anúncios na categoria principal

    // Métricas da amostra
    totalLojasOficiais: totalOficiais,
    totalFull,
    totalFreteGratis: totalFrete,
    totalMercadoLideres: totalMlLideres,
    totalInternacional: totalIntl,
    totalPromocao: totalPromo,
    totalSellers: sellerIds.size,

    pctFull:        +(totalFull   / div * 100).toFixed(1),
    pctFreteGratis: +(totalFrete  / div * 100).toFixed(1),
    pctPromocao:    +(totalPromo  / div * 100).toFixed(1),
    pctOficiais:    +(totalOficiais / div * 100).toFixed(1),
    pctMLLideres:   +(totalMlLideres / div * 100).toFixed(1),

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
