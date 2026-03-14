// routes/validador.js — DEXAN Validador v2.0
// Arquitetura: tudo no backend
// GET  /api/ml-token          → não necessário mais (mantido por compatibilidade)
// POST /api/search-and-analyze → busca ML + métricas + IA em um único endpoint

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;

// ─── App token (client_credentials) ──────────────────────────────────────────
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
  return _appToken;
}

function getUserToken() {
  if (global._mlUserToken && Date.now() < (global._mlUserTokenExpiry || 0)) {
    return global._mlUserToken;
  }
  return null;
}

// ─── GET /api/ml-token (mantido por compatibilidade) ─────────────────────────
export async function handleGetToken(req, res) {
  try {
    const token = await getAppToken();
    res.json({ access_token: token, expires_in: 21600 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── Busca ML com available_filters (modo principal: OAuth token) ─────────────
async function fetchMLSearch(query, token) {
  const q = encodeURIComponent(query);
  const [mainR, minR, maxR] = await Promise.allSettled([
    fetch(`https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=50&sort=relevance`,
      { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_asc`,
      { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`https://api.mercadolibre.com/sites/MLB/search?q=${q}&limit=1&sort=price_desc`,
      { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  if (mainR.status === 'rejected') throw new Error('Fetch rejeitado: ' + mainR.reason);
  const mainResp = mainR.value;
  if (!mainResp.ok) {
    const body = await mainResp.json().catch(() => ({}));
    throw new Error(`MLB/search ${mainResp.status}: ${body.message || JSON.stringify(body).slice(0,100)}`);
  }

  const main = await mainResp.json();
  const items = main.results || [];
  const paging = main.paging || {};
  const avFilters = main.available_filters || [];
  const totalReal = paging.total || 0;

  // Extrair métricas dos available_filters (catálogo completo, não só 50 items)
  const getF = (id, valueId) => {
    const f = avFilters.find(x => x.id === id);
    if (!f) return 0;
    if (valueId) return f.values.find(v => v.id === valueId)?.results || 0;
    return f.values.reduce((a, v) => a + (v.results || 0), 0);
  };

  const totalFull        = getF('fulfillment', 'fulfillment');
  const totalFreteGratis = getF('free_shipping', 'yes');
  const totalOficiais    = getF('official_store');
  const totalLideres     = ['gold','platinum'].reduce((a,id) => a + getF('power_seller_status', id), 0);
  const totalIntl        = (avFilters.find(x => x.id === 'item_location')?.values || [])
    .filter(v => v.id !== 'CBte' && v.id !== 'BR')
    .reduce((a, v) => a + (v.results || 0), 0);

  const sellers = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalPromocao = items.filter(i => i.original_price && i.original_price > i.price).length;
  const prices = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 500000);
  const avgPrice = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;

  let minPrice = prices.length ? Math.min(...prices) : 0;
  let maxPrice = prices.length ? Math.max(...prices) : 0;
  if (minR.status==='fulfilled' && minR.value.ok) {
    const d = await minR.value.json().catch(()=>({}));
    if (d.results?.[0]?.price) minPrice = parseFloat(d.results[0].price);
  }
  if (maxR.status==='fulfilled' && maxR.value.ok) {
    const d = await maxR.value.json().catch(()=>({}));
    if (d.results?.[0]?.price) { const c = parseFloat(d.results[0].price); if (c < 1000000) maxPrice = c; }
  }

  const pct = n => totalReal > 0 ? +((n/totalReal)*100).toFixed(1) : 0;

  return {
    source: 'sites_MLB_search',
    totalAnuncios: totalReal,
    totalFull, totalFreteGratis, totalOficiais, totalLideres, totalIntl,
    totalSellers: sellers.size,
    totalPromocao1aPagina: totalPromocao,
    pctFull: pct(totalFull), pctFreteGratis: pct(totalFreteGratis),
    pctOficiais: pct(totalOficiais), pctLideres: pct(totalLideres), pctIntl: pct(totalIntl),
    pctPromocao: items.length > 0 ? +((totalPromocao/items.length)*100).toFixed(1) : 0,
    precoMedio: avgPrice, precoMin: +minPrice.toFixed(2), precoMax: +maxPrice.toFixed(2),
    mercadoEnderecavel: +(avgPrice * totalReal).toFixed(2),
    topAnuncios: items.slice(0,10).map(i => ({
      id: i.id, title: i.title, price: parseFloat(i.price),
      originalPrice: i.original_price ? parseFloat(i.original_price) : null,
      soldQuantity: i.sold_quantity || 0,
      freeShipping: i.shipping?.free_shipping || false,
      fulfillment: i.shipping?.logistic_type === 'fulfillment',
      isOficial: !!i.official_store_id,
      isPromocao: !!(i.original_price && i.original_price > i.price),
      condition: i.condition, thumbnail: i.thumbnail, link: i.permalink,
      seller: { id: i.seller?.id, nickname: i.seller?.nickname }
    }))
  };
}

// ─── Fallback: /products/search + domain_discovery ───────────────────────────
async function fetchMLFallback(query, token) {
  const q = encodeURIComponent(query);

  const [ddResp, totalResp] = await Promise.allSettled([
    fetch(`https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${q}&limit=3`,
      { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`https://api.mercadolibre.com/products/search?site_id=MLB&q=${q}&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  let totalAnuncios = null;
  let topAnuncios = [];
  let prices = [];

  if (totalResp.status === 'fulfilled' && totalResp.value.ok) {
    const d = await totalResp.value.json();
    totalAnuncios = d.paging?.total || null;
    const items = d.results || [];
    prices = items.map(i => parseFloat(i.buy_box_winner?.price || i.price || 0)).filter(p => p > 0 && p < 500000);
    topAnuncios = items.slice(0,10).map(i => ({
      id: i.id, title: i.name || i.title,
      price: parseFloat(i.buy_box_winner?.price || i.price || 0),
      freeShipping: i.buy_box_winner?.shipping?.free_shipping || false,
      fulfillment: i.buy_box_winner?.shipping?.logistic_type === 'fulfillment',
      condition: 'new', thumbnail: i.pictures?.[0]?.url || '',
      seller: {}
    }));
  }

  // Enriquecer com category total se possível
  if (ddResp.status === 'fulfilled' && ddResp.value.ok) {
    const dd = await ddResp.value.json();
    const catId = dd?.[0]?.category_id;
    if (catId && !totalAnuncios) {
      const catResp = await fetch(
        `https://api.mercadolibre.com/categories/${catId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch(() => null);
      if (catResp?.ok) {
        const cat = await catResp.json();
        totalAnuncios = cat.total_items_in_this_category || totalAnuncios;
      }
    }
  }

  const avg = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;
  const pct = (n,t) => t > 0 ? +((n/t)*100).toFixed(1) : 0;

  return {
    source: 'products_search_fallback',
    totalAnuncios, totalFull: 0, totalFreteGratis: 0, totalOficiais: 0,
    totalLideres: 0, totalIntl: 0, totalSellers: 0, totalPromocao1aPagina: 0,
    pctFull: 0, pctFreteGratis: 0, pctOficiais: 0, pctLideres: 0, pctIntl: 0, pctPromocao: 0,
    precoMedio: avg,
    precoMin: prices.length ? +Math.min(...prices).toFixed(2) : 0,
    precoMax: prices.length ? +Math.max(...prices).toFixed(2) : 0,
    mercadoEnderecavel: +(avg * (totalAnuncios||0)).toFixed(2),
    topAnuncios,
  };
}

// ─── Análise com Claude IA ────────────────────────────────────────────────────
async function analisarComIA(query, m) {
  const isFallback = m.source === 'products_search_fallback';
  const top5 = (m.topAnuncios || []).slice(0,5).map(i =>
    `  - "${i.title}" | R$${i.price} | Full:${i.fulfillment} | Oficial:${i.isOficial||false}`
  ).join('\n');

  const aviso = isFallback
    ? '\n⚠️ DADOS PARCIAIS: apenas buy-box winners. Métricas de Full/Líderes/Oficiais indisponíveis neste modo.'
    : '';

  const prompt = `Você é especialista sênior em inteligência de mercado para e-commerce Brasil (Mercado Livre).
Identifique oportunidades com alta demanda e baixa saturação para revendedores iniciantes a intermediários.${aviso}

Produto: "${query}"

DADOS REAIS ML:
- Total anúncios: ${m.totalAnuncios?.toLocaleString('pt-BR') || 'N/D'}
- Vendedores únicos 1ª pág: ${m.totalSellers || 'N/D'}
- Preço médio: R$ ${m.precoMedio}
- Faixa: R$ ${m.precoMin} — R$ ${m.precoMax}
- Mercado endereçável: R$ ${(m.mercadoEnderecavel||0).toLocaleString('pt-BR')}
- Full ML: ${m.pctFull}% (${m.totalFull} anúncios)
- Frete grátis: ${m.pctFreteGratis}%
- Lojas oficiais: ${m.pctOficiais}%
- ML Líderes gold/platinum: ${m.pctLideres}%
- Internacional: ${m.pctIntl}%

TOP 5:
${top5}

CRITÉRIOS:
Demanda: MUITO ALTA>50k | ALTA 10k-50k | MÉDIA 2k-10k | BAIXA<2k
Saturação: ALTA=Full>40% E Líderes>30% | BAIXA=Full<20% E Líderes<15%
Ticket ideal revenda: R$80-300 ótimo | <R$30 difícil | >R$300 capital alto

Responda APENAS JSON válido sem markdown:
{"score":<0-100>,"veredicto":"EXCELENTE|BOM|MODERADO|ARRISCADO|EVITAR","titulo":"<7 palavras max>","resumo":"<2 frases objetivas com dados>","pontos_favor":["<com número>","<com número>","<concreto>"],"pontos_contra":["<risco real>","<risco real>"],"estrategia":"<3 ações concretas e específicas>","diferencial_sugerido":"<o que fazer diferente dos top vendedores>","margem_estimada":"<ex:25-40%>","ticket_ideal":"<ex:R$ 89-149>","volume_minimo_mensal":"<ex:30-60 unidades/mês>","saturacao":"BAIXA|MEDIA|ALTA","demanda":"BAIXA|MEDIA|ALTA|MUITO ALTA","concorrencia":"BAIXA|MEDIA|ALTA|MUITO ALTA","alerta":null,"score_demanda":<0-100>,"score_saturacao":<0-100>,"score_margem":<0-100>}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!resp.ok) throw new Error('Anthropic ' + resp.status + ': ' + (await resp.text()).slice(0,200));
  const data = await resp.json();
  const txt = data.content?.[0]?.text || '';
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('IA não retornou JSON: ' + txt.slice(0,100));
  return JSON.parse(txt.slice(s, e+1));
}

// ─── POST /api/search-and-analyze ────────────────────────────────────────────
export async function handleSearchAndAnalyze(req, res) {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query obrigatório' });

  try {
    console.log(`[DEXAN Validador] Buscando: "${query}"`);
    const token = getUserToken() || await getAppToken();
    const tokenType = getUserToken() ? 'oauth' : 'client_credentials';

    let metricas;
    try {
      metricas = await fetchMLSearch(query, token);
      console.log(`[DEXAN] /sites/MLB/search OK — total: ${metricas.totalAnuncios} | token: ${tokenType}`);
    } catch(e) {
      console.warn(`[DEXAN] /sites/MLB/search falhou (${e.message}), usando fallback /products/search`);
      metricas = await fetchMLFallback(query, token);
      console.log(`[DEXAN] /products/search fallback — total: ${metricas.totalAnuncios}`);
    }

    const analise = await analisarComIA(query, metricas);
    console.log(`[DEXAN] Score: ${analise.score} | ${analise.veredicto} | source: ${metricas.source}`);

    res.json({ metricas, analise, source: metricas.source });
  } catch(err) {
    console.error('[DEXAN] search-and-analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Manter handleAnalyze por compatibilidade (recebe mlData do cliente)
export async function handleAnalyze(req, res) {
  const { query, mlData } = req.body || {};
  if (!query)  return res.status(400).json({ error: 'query obrigatório' });
  if (!mlData) return res.status(400).json({ error: 'mlData obrigatório' });
  // Redireciona para o novo fluxo ignorando mlData (backend faz a busca)
  req.body = { query };
  return handleSearchAndAnalyze(req, res);
}
