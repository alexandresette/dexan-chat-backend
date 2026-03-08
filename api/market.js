// api/market.js — DEXAN Backend v9
// Estratégia: available_filters da API ML → totais precisos (mesmo método do Metrify)

import https from 'https';
import http from 'http';
import { URL } from 'url';

function fetchViaProxy(targetUrl, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy  = new URL(proxyUrl);
    const connectReq = http.request({
      host: proxy.hostname, port: proxy.port, method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: {
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'),
        'Host': target.hostname
      }
    });
    connectReq.setTimeout(20000, () => { connectReq.destroy(); reject(new Error('Proxy connect timeout')); });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`)); }
      const getReq = https.request({
        host: target.hostname, path: target.pathname + target.search, method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Host': target.hostname },
        socket, agent: false
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

function fetchDirect(targetUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const req = https.request({
      host: target.hostname, path: target.pathname + target.search, method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
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

async function fetchML(product) {
  const user = process.env.IPROYAL_USER;
  const pass = process.env.IPROYAL_PASS;
  const host = process.env.IPROYAL_HOST || 'geo.iproyal.com';
  const port = process.env.IPROYAL_PORT || '12321';
  const q    = encodeURIComponent(product);

  const urlMain     = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=50&sort=relevance`;
  const urlByPrice  = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_asc`;
  const urlMaxPrice = `https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_desc`;

  const doFetch = async (url) => {
    if (user && pass) {
      const proxyUrl = `http://${user}:${encodeURIComponent(pass)}@${host}:${port}`;
      try {
        const r = await fetchViaProxy(url, proxyUrl);
        if (r.status === 200) return r.data;
      } catch(e) { console.log('Proxy falhou:', e.message, '— tentando direto'); }
    }
    const r = await fetchDirect(url);
    if (r.status === 200) return r.data;
    throw new Error(`ML API status ${r.status}`);
  };

  const mainData = await doFetch(urlMain);
  if (!mainData || mainData.error) throw new Error(mainData?.error || 'Sem dados da API ML');

  const [minData, maxData] = await Promise.allSettled([doFetch(urlByPrice), doFetch(urlMaxPrice)]);
  return buildResponse(product, mainData, minData, maxData);
}

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

  const totalReal = paging.total || items.length;

  const fullFilter    = extractFilter(avFilters, 'fulfillment');
  const totalFull     = fullFilter.values.find(v => v.id === 'fulfillment')?.results || 0;

  const freteFilter   = extractFilter(avFilters, 'free_shipping');
  const totalFrete    = freteFilter.values.find(v => v.id === 'yes')?.results || 0;

  const oficialFilter = extractFilter(avFilters, 'official_store');
  const totalOficial  = oficialFilter.total;

  const liderFilter   = extractFilter(avFilters, 'power_seller_status');
  const totalLider    = liderFilter.values.reduce((acc, v) =>
    ['platinum','gold'].includes(v.id) ? acc + (v.results||0) : acc, 0);

  const intlFilter    = extractFilter(avFilters, 'item_location');
  const totalIntl     = intlFilter.values.filter(v => v.id !== 'BR').reduce((acc, v) => acc + (v.results||0), 0);

  const sellersSet    = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalSellers  = sellersSet.size;

  const totalPromocao = items.filter(i => i.original_price && i.original_price > i.price).length;
  const pctPromocao   = items.length > 0 ? Math.round((totalPromocao / items.length) * 100) : 0;

  const prices   = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 100000);
  const avgPrice = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;

  let minPrice = prices.length ? Math.min(...prices) : 0;
  if (minRes.status==='fulfilled' && minRes.value?.results?.[0]?.price) minPrice = parseFloat(minRes.value.results[0].price);

  let maxPrice = prices.length ? Math.max(...prices) : 0;
  if (maxRes.status==='fulfilled' && maxRes.value?.results?.[0]?.price) {
    const c = parseFloat(maxRes.value.results[0].price);
    if (c < 500000) maxPrice = c;
  }

  const mercadoEndereçavel = +(avgPrice * totalReal).toFixed(2);

  const topAnuncios = items.slice(0, 10).map(i => ({
    id: i.id, title: i.title, price: parseFloat(i.price),
    originalPrice: i.original_price ? parseFloat(i.original_price) : null,
    soldQuantity: i.sold_quantity||0,
    freeShipping: i.shipping?.free_shipping||false,
    fulfillment:  i.shipping?.logistic_type==='fulfillment',
    isOficial:    !!i.official_store_id,
    isPromocao:   !!(i.original_price && i.original_price > i.price),
    condition: i.condition, thumbnail: i.thumbnail, link: i.permalink,
    seller: { id: i.seller?.id, nickname: i.seller?.nickname, level: i.seller?.seller_reputation?.level_id }
  }));

  return {
    source: 'ml_filters_v9', query: product,
    totalAnuncios: totalReal, totalLojasOficiais: totalOficial,
    totalFull, totalFreteGratis: totalFrete,
    totalMercadoLideres: totalLider, totalInternacional: totalIntl, totalSellers,
    pctLojasOficiais: totalReal>0 ? +((totalOficial/totalReal)*100).toFixed(1) : 0,
    pctFull:          totalReal>0 ? +((totalFull/totalReal)*100).toFixed(1) : 0,
    pctFreteGratis:   totalReal>0 ? +((totalFrete/totalReal)*100).toFixed(1) : 0,
    pctLideres:       totalReal>0 ? +((totalLider/totalReal)*100).toFixed(1) : 0,
    pctInternacional: totalReal>0 ? +((totalIntl/totalReal)*100).toFixed(1) : 0,
    totalPromocao1aPagina: totalPromocao, pctPromocao1aPagina: pctPromocao,
    precoMedio: avgPrice, precoMin: +minPrice.toFixed(2), precoMax: +maxPrice.toFixed(2),
    mercadoEndereçavel, topAnuncios,
    _filtersRaw: avFilters.map(f => ({ id: f.id, name: f.name, qtd_valores: f.values?.length }))
  };
}