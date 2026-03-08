// routes/market.js — DEXAN Backend v7.0
// Scraping REAL das 20 páginas ML com keyword exata
// Dados: total anúncios, lojas oficiais, full, frete grátis, ML líderes,
//        venda internacional, promoções, mercado endereçável, preço médio p1 e p20

import { ProxyAgent } from 'undici';

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

function getProxyAgent() {
  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  if (!user || !pass) return null;
  try {
    return new ProxyAgent({
      uri: `http://${user}:${pass}@${host}:${port}`,
      connectTimeout: 20000
    });
  } catch(e) {
    console.warn('Proxy agent error:', e.message);
    return null;
  }
}

async function fetchMLSearchPage(query, offset, token, proxy) {
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(query)}&limit=50&offset=${offset}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; DEXAN/1.0)'
  };

  if (proxy) {
    try {
      const resp = await fetch(url, { dispatcher: proxy, headers });
      if (resp.ok) return resp.json();
      console.warn(`Proxy falhou offset=${offset}: ${resp.status}`);
    } catch(e) {
      console.warn(`Proxy erro offset=${offset}: ${e.message}`);
    }
  }

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`ML search ${resp.status} offset=${offset}`);
  return resp.json();
}

function analyzeResults(results) {
  const metrics = {
    count: 0,
    oficiais: 0,
    full: 0,
    freteGratis: 0,
    mercadoLideres: 0,
    internacional: 0,
    promocao: 0,
    somaPrecos: 0,
    precos: [],
    sellers: new Set()
  };

  for (const item of results) {
    metrics.count++;
    const preco = item.price || 0;
    if (preco > 0 && preco < 500000) {
      metrics.somaPrecos += preco;
      metrics.precos.push(preco);
    }

    if (item.official_store_id || item.official_store_name) metrics.oficiais++;

    const logistic = item.shipping?.logistic_type || '';
    if (logistic === 'fulfillment') metrics.full++;

    if (item.shipping?.free_shipping) metrics.freteGratis++;

    const level = item.seller?.seller_reputation?.level_id || '';
    if (level.includes('gold') || level.includes('platinum')) metrics.mercadoLideres++;

    if (item.international_delivery_mode && item.international_delivery_mode !== 'none') {
      metrics.internacional++;
    }

    if (item.original_price && item.original_price > item.price) metrics.promocao++;

    if (item.seller?.id) metrics.sellers.add(item.seller.id);
  }

  return metrics;
}

async function fetchMarketData(product) {
  const token = await getMLToken();
  const proxy = getProxyAgent();

  console.log(`Buscando "${product}" via ML API...`);

  let page1;
  try {
    page1 = await fetchMLSearchPage(product, 0, token, proxy);
  } catch(e) {
    throw new Error(`Falha na busca ML: ${e.message}`);
  }

  const totalBusca = page1.paging?.total || 0;
  const resultadosPorPagina = page1.paging?.limit || 50;
  const queryRetornada = page1.query || product;
  const nomeCategoria = page1.filters?.find(f => f.id === 'category')?.values?.[0]?.name || null;

  console.log(`Total: ${totalBusca} | Categoria: ${nomeCategoria}`);

  const page1Results = page1.results || [];
  const metricasP1 = analyzeResults(page1Results);

  const maxItems = Math.min(totalBusca, 1000);
  const totalPaginas = Math.ceil(maxItems / resultadosPorPagina);
  const paginasParaBuscar = Math.min(totalPaginas, 20);

  const allResults = [...page1Results];

  for (let batchStart = 1; batchStart < paginasParaBuscar; batchStart += 5) {
    const batchEnd = Math.min(batchStart + 5, paginasParaBuscar);
    const batch = [];

    for (let p = batchStart; p < batchEnd; p++) {
      const offset = p * resultadosPorPagina;
      batch.push(
        fetchMLSearchPage(product, offset, token, proxy)
          .then(d => d.results || [])
          .catch(e => { console.warn(`Pag ${p+1} falhou: ${e.message}`); return []; })
      );
    }

    const batchResults = await Promise.all(batch);
    batchResults.forEach(r => allResults.push(...r));

    if (batchEnd < paginasParaBuscar) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`Items coletados: ${allResults.length}`);

  const metricas20 = analyzeResults(allResults);

  const precoMedioP1 = metricasP1.precos.length
    ? metricasP1.precos.reduce((a,b)=>a+b,0) / metricasP1.precos.length : null;

  const precos20 = metricas20.precos;
  const precoMedio20 = precos20.length
    ? precos20.reduce((a,b)=>a+b,0) / precos20.length : null;

  const topMap = {};
  for (const item of allResults) {
    const sid = item.seller?.id;
    if (!sid) continue;
    if (!topMap[sid]) {
      topMap[sid] = {
        sellerNickname: item.seller?.nickname || null,
        sellerLevel: item.seller?.seller_reputation?.level_id || null,
        powerStatus: item.seller?.seller_reputation?.power_seller_status || null,
        count: 0, somaPrecos: 0, topItem: null
      };
    }
    topMap[sid].count++;
    topMap[sid].somaPrecos += item.price || 0;
    if (!topMap[sid].topItem) {
      topMap[sid].topItem = {
        id: item.id, title: item.title, price: item.price,
        freeShipping: item.shipping?.free_shipping || false,
        fulfillment: item.shipping?.logistic_type === 'fulfillment',
        originalPrice: item.original_price || null,
        link: item.permalink, thumbnail: item.thumbnail
      };
    }
  }

  const topSellers = Object.values(topMap)
    .sort((a,b) => b.somaPrecos - a.somaPrecos)
    .slice(0, 5)
    .map(s => ({
      sellerNickname: s.sellerNickname,
      sellerLevel: s.sellerLevel,
      powerStatus: s.powerStatus,
      anunciosEncontrados: s.count,
      faturamentoEstimado: +s.somaPrecos.toFixed(2),
      topItem: s.topItem
    }));

  const melhoresAnuncios = page1Results.slice(0, 10).map(item => ({
    id: item.id,
    title: item.title,
    price: item.price,
    originalPrice: item.original_price || null,
    freeShipping: item.shipping?.free_shipping || false,
    fulfillment: item.shipping?.logistic_type === 'fulfillment',
    sellerNickname: item.seller?.nickname || null,
    sellerLevel: item.seller?.seller_reputation?.level_id || null,
    condition: item.condition,
    thumbnail: item.thumbnail,
    link: item.permalink,
    isOficial: !!(item.official_store_id || item.official_store_name),
    isPromocao: !!(item.original_price && item.original_price > item.price),
    isInternacional: !!(item.international_delivery_mode && item.international_delivery_mode !== 'none')
  }));

  return {
    source: 'ml_scraping_v7',
    query: product,
    queryRetornada,
    nomeCategoria,
    paginasAnalisadas: paginasParaBuscar,
    itemsAnalisados: allResults.length,

    totalAnuncios: totalBusca,
    totalLojasOficiais: metricas20.oficiais,
    totalFull: metricas20.full,
    totalFreteGratis: metricas20.freteGratis,
    totalMercadoLideres: metricas20.mercadoLideres,
    totalInternacional: metricas20.internacional,
    totalPromocao: metricas20.promocao,
    totalSellers: metricas20.sellers.size,

    mercadoEnderecavel: +metricas20.somaPrecos.toFixed(2),
    precoMedioP1: precoMedioP1 ? +precoMedioP1.toFixed(2) : null,
    precoMedio20: precoMedio20 ? +precoMedio20.toFixed(2) : null,
    precoMin: precos20.length ? +Math.min(...precos20).toFixed(2) : null,
    precoMax: precos20.length ? +Math.max(...precos20).toFixed(2) : null,

    pctFull: allResults.length ? +(metricas20.full / allResults.length * 100).toFixed(1) : 0,
    pctFreteGratis: allResults.length ? +(metricas20.freteGratis / allResults.length * 100).toFixed(1) : 0,
    pctPromocao: allResults.length ? +(metricas20.promocao / allResults.length * 100).toFixed(1) : 0,
    pctOficiais: allResults.length ? +(metricas20.oficiais / allResults.length * 100).toFixed(1) : 0,

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
