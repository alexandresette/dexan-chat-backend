// routes/market.js — DEXAN Backend v9
// Estratégia: available_filters da API ML → totais precisos (mesmo método do Metrify)
// Nota: proxy IPRoyal não funciona no Railway (conexão cancelada pelo ambiente)

import https from 'https';
import { URL } from 'url';

// ─── Cache do token ML ────────────────────────────────────────────────────────

let _mlToken = null;
let _mlTokenExpiry = 0;

async function getMLToken() {
  if (_mlToken && Date.now() < _mlTokenExpiry) return _mlToken;

  const CLIENT_ID     = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('ML_CLIENT_ID/SECRET não configurados');

  const body = `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`;
  const data = await mlRawFetch('https://api.mercadolibre.com/oauth/token', 'POST', body, 'application/x-www-form-urlencoded');

  _mlToken       = data.access_token;
  _mlTokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // renova 5min antes
  console.log('✅ Token ML renovado');
  return _mlToken;
}

// ─── Fetch nativo Node.js ─────────────────────────────────────────────────────

function mlRawFetch(url, method = 'GET', body = null, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const opts = {
      host:   target.hostname,
      path:   target.pathname + target.search,
      method,
      headers: {
        'Accept':       'application/json',
        'User-Agent':   'DEXAN-Radar/9.0',
        'Content-Type': contentType,
      }
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(opts, (resp) => {
      let raw = '';
      resp.on('data', d => raw += d);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, data: JSON.parse(raw) }); }
        catch(e) { reject(new Error('JSON parse: ' + raw.substring(0, 100))); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout' )); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function mlFetch(url) {
  const token = await getMLToken();
  const r = await mlRawFetch(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now());
  if (r.status === 401) {
    // Token expirou — forçar renovação
    _mlToken = null;
    const token2 = await getMLToken();
    const r2 = await mlRawFetch(url);
    if (r2.status !== 200) throw new Error(`ML API ${r2.status}: ${JSON.stringify(r2.data).substring(0,100)}`);
    return r2.data;
  }
  // Adiciona o token no header corretamente
  return mlFetchWithToken(url, token);
}

async function mlFetchWithToken(url, token) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      host:   target.hostname,
      path:   target.pathname + target.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
        'User-Agent':    'DEXAN-Radar/9.0',
      }
    }, (resp) => {
      let raw = '';
      resp.on('data', d => raw += d);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, data: JSON.parse(raw) }); }
        catch(e) { reject(new Error('JSON parse: ' + raw.substring(0,100))); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function doFetch(url) {
  const token = await getMLToken();
  const r = await mlFetchWithToken(url, token);
  if (r.status === 200) return r.data;
  throw new Error(`ML API ${r.status}: ${JSON.stringify(r.data).substring(0,150)}`);
}

// ─── Handler principal ────────────────────────────────────────────────────────

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
    return res.status(400).json({ error: 'source invalida. Use: mercadolivre' });
  } catch (err) {
    console.error('market error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Core: available_filters → totais precisos ───────────────────────────────

async function fetchML(product) {
  const q = encodeURIComponent(product);

  const urlMain     = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=50&sort=relevance`;
  const urlMinPrice = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_asc`;
  const urlMaxPrice = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_desc`;

  // Busca principal + min/max em paralelo
  const mainData = await doFetch(urlMain);
  if (!mainData || mainData.error) throw new Error(mainData?.error || 'Sem dados ML');

  const [minRes, maxRes] = await Promise.allSettled([
    doFetch(urlMinPrice),
    doFetch(urlMaxPrice)
  ]);

  return buildResponse(product, mainData, minRes, maxRes);
}

// ─── Extrai totais dos available_filters ─────────────────────────────────────

function extractFilter(filters, filterId) {
  const f = filters.find(f => f.id === filterId);
  if (!f) return { total: 0, values: [] };
  const total = f.values.reduce((acc, v) => acc + (v.results || 0), 0);
  return { total, values: f.values };
}

function buildResponse(product, main, minRes, maxRes) {
  const paging    = main.paging || {};
  const items     = main.results || [];
  const avFilters = main.available_filters || [];

  // Total real do catálogo (não primary_results)
  const totalReal = paging.total || items.length;

  // Totais via available_filters (catálogo completo — como o Metrify)
  const fullFilter    = extractFilter(avFilters, 'fulfillment');
  const totalFull     = fullFilter.values.find(v => v.id === 'fulfillment')?.results || 0;

  const freteFilter   = extractFilter(avFilters, 'free_shipping');
  const totalFrete    = freteFilter.values.find(v => v.id === 'yes')?.results || 0;

  const oficialFilter = extractFilter(avFilters, 'official_store');
  const totalOficial  = oficialFilter.total;

  const liderFilter   = extractFilter(avFilters, 'power_seller_status');
  const totalLider    = liderFilter.values.reduce((acc, v) =>
    ['platinum', 'gold'].includes(v.id) ? acc + (v.results || 0) : acc, 0);

  const intlFilter    = extractFilter(avFilters, 'item_location');
  const totalIntl     = intlFilter.values
    .filter(v => v.id !== 'BR')
    .reduce((acc, v) => acc + (v.results || 0), 0);

  const sellersSet   = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalSellers = sellersSet.size;

  // Promoção — 1ª página (igual ao Metrify)
  const totalPromocao = items.filter(i => i.original_price && i.original_price > i.price).length;
  const pctPromocao   = items.length > 0 ? Math.round((totalPromocao / items.length) * 100) : 0;

  // Preços
  const prices   = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 100000);
  const avgPrice = prices.length ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : 0;

  let minPrice = prices.length ? Math.min(...prices) : 0;
  if (minRes.status === 'fulfilled' && minRes.value?.results?.[0]?.price)
    minPrice = parseFloat(minRes.value.results[0].price);

  let maxPrice = prices.length ? Math.max(...prices) : 0;
  if (maxRes.status === 'fulfilled' && maxRes.value?.results?.[0]?.price) {
    const c = parseFloat(maxRes.value.results[0].price);
    if (c < 500000) maxPrice = c;
  }

  const mercadoEndereçavel = +(avgPrice * totalReal).toFixed(2);

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
      id:       i.seller?.id,
      nickname: i.seller?.nickname,
      level:    i.seller?.seller_reputation?.level_id
    }
  }));

  return {
    source:  'ml_filters_v9',
    query:   product,

    totalAnuncios:       totalReal,
    totalLojasOficiais:  totalOficial,
    totalFull,
    totalFreteGratis:    totalFrete,
    totalMercadoLideres: totalLider,
    totalInternacional:  totalIntl,
    totalSellers,

    pctLojasOficiais: totalReal > 0 ? +((totalOficial / totalReal) * 100).toFixed(1) : 0,
    pctFull:          totalReal > 0 ? +((totalFull     / totalReal) * 100).toFixed(1) : 0,
    pctFreteGratis:   totalReal > 0 ? +((totalFrete    / totalReal) * 100).toFixed(1) : 0,
    pctLideres:       totalReal > 0 ? +((totalLider    / totalReal) * 100).toFixed(1) : 0,
    pctInternacional: totalReal > 0 ? +((totalIntl     / totalReal) * 100).toFixed(1) : 0,

    totalPromocao1aPagina: totalPromocao,
    pctPromocao1aPagina:   pctPromocao,

    precoMedio:         avgPrice,
    precoMin:           +minPrice.toFixed(2),
    precoMax:           +maxPrice.toFixed(2),
    mercadoEndereçavel,

    topAnuncios,
    _filtersRaw: avFilters.map(f => ({ id: f.id, name: f.name, qtd_valores: f.values?.length }))
  };
}
