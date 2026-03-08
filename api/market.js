// api/market.js — DEXAN Backend v9
// Estratégia: available_filters da API ML → totais precisos (mesmo método do Metrify)
// Uma única chamada retorna contagens reais de todos os filtros sem precisar paginar

import https from 'https';
import http from 'http';
import { URL } from 'url';

// ─── Proxy IPRoyal (HTTP CONNECT tunnel) ────────────────────────────────────

function fetchViaProxy(targetUrl, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy  = new URL(proxyUrl);

    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: {
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'),
        'Host': target.hostname
      }
    });

    connectReq.setTimeout(20000, () => { connectReq.destroy(); reject(new Error('Proxy connect timeout')); });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }

      const getReq = https.request({
        host: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Host': target.hostname
        },
        socket,
        agent: false
      });

      getReq.setTimeout(20000, () => { getReq.destroy(); reject(new Error('Request timeout')); });

      getReq.on('response', (resp) => {
        let body = '';
        resp.on('data', d => body += d);
        resp.on('end', () => {
          try { resolve({ status: resp.statusCode, data: JSON.parse(body) }); }
          catch(e) { reject(new Error('JSON parse error: ' + body.substring(0, 200))); }
        });
      });

      getReq.on('error', reject);
      getReq.end();
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

// ─── Fetch simples sem proxy (fallback) ──────────────────────────────────────

function fetchDirect(targetUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const req = https.request({
      host: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Direct timeout')); });
    req.on('response', (resp) => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, data: JSON.parse(body) }); }
        catch(e) { reject(new Error('JSON parse: ' + body.substring(0, 100))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Handler principal ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { product, source } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product required' });

  try {
    if (source === 'mercadolivre') return res.json(await fetchML(product));
    return res.status(400).json({ error: 'source inválida. Use: mercadolivre' });
  } catch (err) {
    console.error('market error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Core: busca ML com available_filters ────────────────────────────────────

async function fetchML(product) {
  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  const q    = encodeURIComponent(product);

  // URLs que vamos buscar em paralelo:
  // 1. Busca principal com limit=50 (métricas de available_filters + primeira página real)
  // 2. Busca com offset=0&limit=50 sem sort (para preço mín/máx mais representativo)
  const urlMain    = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=50&sort=relevance`;
  const urlByPrice = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_asc`;
  const urlMaxPrice= `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_desc`;

  const doFetch = async (url) => {
    if (user && pass) {
      const proxyUrl = `http://${user}:${encodeURIComponent(pass)}@${host}:${port}`;
      try {
        const r = await fetchViaProxy(url, proxyUrl);
        if (r.status === 200) return r.data;
      } catch(e) {
        console.log('Proxy falhou:', e.message, '— tentando direto');
      }
    }
    const r = await fetchDirect(url);
    if (r.status === 200) return r.data;
    throw new Error(`ML API status ${r.status}`);
  };

  // Busca principal (inclui available_filters com TOTAIS REAIS)
  const mainData = await doFetch(urlMain);

  if (!mainData || mainData.error) {
    throw new Error(mainData?.error || 'Sem dados da API ML');
  }

  // Busca min/max de preço em paralelo (não bloqueia se falhar)
  const [minData, maxData] = await Promise.allSettled([
    doFetch(urlByPrice),
    doFetch(urlMaxPrice)
  ]);

  return buildResponse(product, mainData, minData, maxData);
}

// ─── Extrai métricas dos available_filters (chave do método) ────────────────

function extractFilter(filters, filterId) {
  // Procura em available_filters (filtros ainda não aplicados com totais)
  const f = filters.find(f => f.id === filterId);
  if (!f) return { total: 0, values: [] };
  // Soma todos os valores do filtro
  const total = f.values.reduce((acc, v) => acc + (v.results || 0), 0);
  return { total, values: f.values };
}

function buildResponse(product, main, minRes, maxRes) {
  const paging   = main.paging || {};
  const items    = main.results || [];
  const avFilters = main.available_filters || [];
  const appliedFilters = main.filters || [];

  // ── Total real ──────────────────────────────────────────────────────────
  // paging.total = TODOS os anúncios indexados (igual ao Metrify)
  // paging.primary_results = só os "relevantes" (menor, o que pegávamos antes)
  const totalReal = paging.total || items.length;

  // ── Métricas via available_filters (totais do catálogo inteiro) ─────────
  // Fulfillment / FULL
  const fullFilter    = extractFilter(avFilters, 'fulfillment');
  const totalFull     = fullFilter.values.find(v => v.id === 'fulfillment')?.results || 0;

  // Frete Grátis
  const freteFilter   = extractFilter(avFilters, 'free_shipping');
  const totalFrete    = freteFilter.values.find(v => v.id === 'yes')?.results || 0;

  // Lojas Oficiais
  const oficialFilter = extractFilter(avFilters, 'official_store');
  // Soma todas as lojas oficiais (cada valor é uma loja)
  const totalOficial  = oficialFilter.total;

  // Mercado Líderes (power_seller)
  const liderFilter   = extractFilter(avFilters, 'power_seller_status');
  const totalLider    = liderFilter.values.reduce((acc, v) => {
    // platinum + gold = Mercado Líderes
    if (['platinum', 'gold'].includes(v.id)) return acc + (v.results || 0);
    return acc;
  }, 0);

  // Internacional
  const intlFilter    = extractFilter(avFilters, 'item_location');
  const totalIntl     = intlFilter.values
    .filter(v => v.id !== 'BR')
    .reduce((acc, v) => acc + (v.results || 0), 0);

  // Sellers únicos (da amostra da 1ª página — não tem no filtro)
  const sellersSet = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalSellers = sellersSet.size;

  // ── Promoções (1ª página — igual ao Metrify que diz "na primeira página") ─
  const totalPromocao = items.filter(i =>
    i.original_price && i.original_price > i.price
  ).length;
  const pctPromocao = items.length > 0
    ? Math.round((totalPromocao / items.length) * 100)
    : 0;

  // ── Preços (amostra 1ª página + min/max absolutos) ──────────────────────
  const prices = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 100000);
  const avgPrice = prices.length
    ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)
    : 0;

  // Preço mínimo absoluto (sort=price_asc)
  let minPrice = prices.length ? Math.min(...prices) : 0;
  if (minRes.status === 'fulfilled' && minRes.value?.results?.[0]?.price) {
    minPrice = parseFloat(minRes.value.results[0].price);
  }

  // Preço máximo absoluto (sort=price_desc)
  let maxPrice = prices.length ? Math.max(...prices) : 0;
  if (maxRes.status === 'fulfilled' && maxRes.value?.results?.[0]?.price) {
    const candidate = parseFloat(maxRes.value.results[0].price);
    if (candidate < 500000) maxPrice = candidate; // sanity check
  }

  // ── Mercado Endereçável ─────────────────────────────────────────────────
  // Metrify: soma preços dos resultados × algum fator
  // Nossa versão: preço médio × total (estimativa conservadora do TAM)
  const mercadoEndereçavel = +(avgPrice * totalReal).toFixed(2);

  // ── Top anúncios formatados ─────────────────────────────────────────────
  const topAnuncios = items.slice(0, 10).map(i => ({
    id:           i.id,
    title:        i.title,
    price:        parseFloat(i.price),
    originalPrice: i.original_price ? parseFloat(i.original_price) : null,
    soldQuantity: i.sold_quantity || 0,
    freeShipping: i.shipping?.free_shipping || false,
    fulfillment:  i.shipping?.logistic_type === 'fulfillment',
    isOficial:    !!i.official_store_id,
    isPromocao:   !!(i.original_price && i.original_price > i.price),
    condition:    i.condition,
    thumbnail:    i.thumbnail,
    link:         i.permalink,
    seller: {
      id:         i.seller?.id,
      nickname:   i.seller?.nickname,
      level:      i.seller?.seller_reputation?.level_id
    }
  }));

  // ── Resposta final ──────────────────────────────────────────────────────
  return {
    source:  'ml_filters_v9',
    query:   product,
    metodologia: 'available_filters (totais reais do catálogo ML)',

    // Totais absolutos (como o Metrify)
    totalAnuncios:       totalReal,
    totalLojasOficiais:  totalOficial,
    totalFull:           totalFull,
    totalFreteGratis:    totalFrete,
    totalMercadoLideres: totalLider,
    totalInternacional:  totalIntl,
    totalSellers:        totalSellers,

    // Percentuais
    pctLojasOficiais:  totalReal > 0 ? +((totalOficial / totalReal) * 100).toFixed(1) : 0,
    pctFull:           totalReal > 0 ? +((totalFull / totalReal) * 100).toFixed(1) : 0,
    pctFreteGratis:    totalReal > 0 ? +((totalFrete / totalReal) * 100).toFixed(1) : 0,
    pctLideres:        totalReal > 0 ? +((totalLider / totalReal) * 100).toFixed(1) : 0,
    pctInternacional:  totalReal > 0 ? +((totalIntl / totalReal) * 100).toFixed(1) : 0,

    // Promoção (1ª página, como Metrify)
    totalPromocao1aPagina: totalPromocao,
    pctPromocao1aPagina:   pctPromocao,

    // Preços
    precoMedio: avgPrice,
    precoMin:   +minPrice.toFixed(2),
    precoMax:   +maxPrice.toFixed(2),

    // Mercado endereçável
    mercadoEndereçavel,

    // Anúncios da 1ª página
    topAnuncios,

    // Filtros disponíveis brutos (para debug/futuro uso)
    _filtersRaw: avFilters.map(f => ({ id: f.id, name: f.name, qtd_valores: f.values?.length }))
  };
}
