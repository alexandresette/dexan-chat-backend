// routes/market.js — DEXAN Backend v9.2
// /products/search funciona com client_credentials (v7 funcionava)
// available_filters vem dessa resposta — usamos para totais do catálogo

import https from 'https';
import { URL } from 'url';

let _mlToken = null;
let _mlTokenExpiry = 0;

async function getMLToken() {
  if (_mlToken && Date.now() < _mlTokenExpiry) return _mlToken;
  const CLIENT_ID     = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('ML_CLIENT_ID/SECRET nao configurados');
  const body = `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`;
  const r = await rawFetch('https://api.mercadolibre.com/oauth/token', 'POST', body, 'application/x-www-form-urlencoded');
  if (r.status !== 200) throw new Error(`Token ML falhou ${r.status}: ${JSON.stringify(r.data).substring(0,200)}`);
  _mlToken = r.data.access_token;
  _mlTokenExpiry = Date.now() + ((r.data.expires_in || 21600) - 300) * 1000;
  console.log('Token ML renovado');
  return _mlToken;
}

function rawFetch(url, method, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'DEXAN-Radar/9.2' }
    };
    if (body) {
      opts.headers['Content-Type'] = contentType || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { reject(new Error('JSON: ' + raw.substring(0,150))); }
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function mlGet(path) {
  const token = await getMLToken();
  const url = path.startsWith('http') ? path : 'https://api.mercadolibre.com' + path;
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'DEXAN-Radar/9.2',
      }
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { reject(new Error('JSON: ' + raw.substring(0,150))); }
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

export async function handleMarket(req, res) {
  const { product, source } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product required' });
  if (source !== 'mercadolivre') return res.status(400).json({ error: 'source invalida. Use: mercadolivre' });
  try {
    return res.json(await fetchML(product));
  } catch(err) {
    console.error('market error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── /products/search — funciona com client_credentials ──────────────────────
// Retorna produtos do catálogo ML (não anúncios diretos)
// available_filters disponíveis: fulfillment, free_shipping, official_store, etc.

async function fetchML(product) {
  const q = encodeURIComponent(product);

  // Busca principal — 50 produtos do catálogo
  const mainR = await mlGet(`/sites/MLB/search?q=${q}&limit=50&sort=relevance`);

  if (mainR.status !== 200) {
    throw new Error(`ML search ${mainR.status}: ${JSON.stringify(mainR.data).substring(0,200)}`);
  }

  const main = mainR.data;
  console.log(`Busca "${product}": total=${main.paging?.total}, filtros=${main.available_filters?.length}`);

  // Preço min/max em paralelo
  const [minR, maxR] = await Promise.allSettled([
    mlGet(`/sites/MLB/search?q=${q}&limit=1&sort=price_asc`),
    mlGet(`/sites/MLB/search?q=${q}&limit=1&sort=price_desc`)
  ]);

  return buildResponse(product, main, minR, maxR);
}

function getFilter(filters, id) {
  const f = (filters || []).find(x => x.id === id);
  if (!f) return { total: 0, values: [] };
  return { total: f.values.reduce((a, v) => a + (v.results || 0), 0), values: f.values || [] };
}

function buildResponse(product, main, minR, maxR) {
  const items     = main.results || [];
  const paging    = main.paging  || {};
  const avFilters = main.available_filters || [];
  const totalReal = paging.total || items.length;

  // available_filters do /products/search
  const fullF    = getFilter(avFilters, 'fulfillment');
  const totalFull= fullF.values.find(v => v.id === 'fulfillment')?.results || 0;

  const freteF   = getFilter(avFilters, 'free_shipping');
  const totalFrete= freteF.values.find(v => v.id === 'yes')?.results || 0;

  const oficF    = getFilter(avFilters, 'official_store');
  const totalOficial = oficF.total;

  const liderF   = getFilter(avFilters, 'power_seller_status');
  const totalLider = liderF.values.reduce((a,v) =>
    ['platinum','gold'].includes(v.id) ? a + (v.results||0) : a, 0);

  const intlF    = getFilter(avFilters, 'item_location');
  const totalIntl= intlF.values.filter(v => v.id !== 'BR').reduce((a,v) => a+(v.results||0), 0);

  const sellers  = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalPromocao = items.filter(i => i.original_price && i.original_price > i.price).length;
  const pctPromocao   = items.length ? +((totalPromocao/items.length)*100).toFixed(1) : 0;

  const prices  = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 200000);
  const avgPrice= prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;

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
    source: 'ml_products_v9.2',
    query:  product,
    totalAnuncios:       totalReal,
    totalLojasOficiais:  totalOficial,
    totalFull,
    totalFreteGratis:    totalFrete,
    totalMercadoLideres: totalLider,
    totalInternacional:  totalIntl,
    totalSellers:        sellers.size,
    pctLojasOficiais:    totalReal > 0 ? +((totalOficial/totalReal)*100).toFixed(1) : 0,
    pctFull:             totalReal > 0 ? +((totalFull/totalReal)*100).toFixed(1) : 0,
    pctFreteGratis:      totalReal > 0 ? +((totalFrete/totalReal)*100).toFixed(1) : 0,
    pctLideres:          totalReal > 0 ? +((totalLider/totalReal)*100).toFixed(1) : 0,
    pctInternacional:    totalReal > 0 ? +((totalIntl/totalReal)*100).toFixed(1) : 0,
    totalPromocao1aPagina: totalPromocao,
    pctPromocao1aPagina:   pctPromocao,
    precoMedio:           avgPrice,
    precoMin:             +minPrice.toFixed(2),
    precoMax:             +maxPrice.toFixed(2),
    mercadoEndereçavel:   +(avgPrice * totalReal).toFixed(2),
    topAnuncios,
    _debug: { totalFiltros: avFilters.length, filtrosIds: avFilters.map(f=>f.id) }
  };
}
