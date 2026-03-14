// routes/validador.js — DEXAN Validador v3.0
// Modo PRINCIPAL:  OAuth user token → /sites/MLB/search (dados reais completos)
// Modo FALLBACK:   client_credentials → products/search (buy-box only)
// POST /api/validar → { query } → métricas + IA

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;

// ─── Token client_credentials (fallback) ─────────────────────────────────────
let _appToken = null;
let _appTokenExpiry = 0;

async function getAppToken() {
  if (_appToken && Date.now() < _appTokenExpiry) return _appToken;
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
  });
  if (!r.ok) throw new Error('Token app falhou: ' + r.status);
  const d = await r.json();
  _appToken = d.access_token;
  _appTokenExpiry = Date.now() + (d.expires_in - 300) * 1000;
  return _appToken;
}

// ─── Token OAuth de usuário (principal) ──────────────────────────────────────
function getUserToken() {
  if (global._mlUserToken && Date.now() < global._mlUserTokenExpiry) {
    return global._mlUserToken;
  }
  return null;
}

// ─── Fetch ML seguro ─────────────────────────────────────────────────────────
async function mlGet(path, token) {
  const r = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!r.ok) return null;
  return r.json();
}

async function pAll(tasks, concurrency = 20) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = await Promise.all(
      tasks.slice(i, i + concurrency).map(fn => fn().catch(() => null))
    );
    results.push(...batch);
  }
  return results;
}

// ─── MODO PRINCIPAL: OAuth → /sites/MLB/search ───────────────────────────────
async function buscarComOAuth(query, token) {
  const q = encodeURIComponent(query);
  const base = `/sites/MLB/search?q=${q}`;

  // Busca principal + min/max em paralelo
  const [main, minR, maxR] = await Promise.all([
    mlGet(`${base}&limit=50&sort=relevance`, token),
    mlGet(`${base}&limit=1&sort=price_asc`, token),
    mlGet(`${base}&limit=1&sort=price_desc`, token),
  ]);

  if (!main || main.error) throw new Error('sites/MLB/search falhou com OAuth');

  const items     = main.results || [];
  const paging    = main.paging  || {};
  const avFilters = main.available_filters || [];
  const total     = paging.total || 0;

  // Métricas via available_filters — dados do catálogo COMPLETO
  const getF = (id, vid) => {
    const f = avFilters.find(x => x.id === id);
    if (!f) return 0;
    return vid
      ? (f.values.find(v => v.id === vid)?.results || 0)
      : f.values.reduce((a, v) => a + (v.results || 0), 0);
  };

  const totalFull   = getF('fulfillment', 'fulfillment');
  const totalFrete  = getF('free_shipping', 'yes');
  const totalOfic   = getF('official_store');
  const totalLideres = ['gold','platinum'].reduce((a,id) => a + getF('power_seller_status', id), 0);
  const totalIntl   = (avFilters.find(x => x.id === 'item_location')?.values || [])
    .filter(v => v.id !== 'CBte' && v.id !== 'BR')
    .reduce((a, v) => a + (v.results || 0), 0);

  const prices  = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 500000);
  const avg     = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;
  const sellers = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const promo   = items.filter(i => i.original_price && i.original_price > i.price).length;

  let minPrice = prices.length ? Math.min(...prices) : 0;
  let maxPrice = prices.length ? Math.max(...prices) : 0;
  if (minR?.results?.[0]?.price) minPrice = parseFloat(minR.results[0].price);
  if (maxR?.results?.[0]?.price) { const c = parseFloat(maxR.results[0].price); if (c < 1000000) maxPrice = c; }

  const pct = v => total > 0 ? +((v/total)*100).toFixed(1) : 0;

  const topAnuncios = items.slice(0, 8).map(i => ({
    title:        i.title,
    price:        parseFloat(i.price),
    originalPrice: i.original_price ? parseFloat(i.original_price) : null,
    freeShipping: i.shipping?.free_shipping || false,
    fulfillment:  i.shipping?.logistic_type === 'fulfillment',
    isOficial:    !!i.official_store_id,
    isPromocao:   !!(i.original_price && i.original_price > i.price),
    condition:    i.condition,
    thumbnail:    i.thumbnail,
    link:         i.permalink,
    seller:       i.seller?.nickname || null,
  }));

  // Categoria via domain_discovery (em paralelo, não bloqueia)
  const dd = await mlGet(`/sites/MLB/domain_discovery/search?q=${q}&limit=3`, token);
  const categories = (dd || []).map(d => ({ id: d.category_id, name: d.category_name }));

  return {
    query, fonte: 'oauth_sites_MLB_search',
    totalAnuncios: total,
    totalSampled: items.length,
    totalSellers: sellers.size,
    totalFull, totalFreteGratis: totalFrete,
    totalOficiais: totalOfic, totalLideres,
    totalIntl, totalPromocao: promo,
    pctFull:         pct(totalFull),
    pctFreteGratis:  pct(totalFrete),
    pctOficiais:     pct(totalOfic),
    pctLideres:      pct(totalLideres),
    pctIntl:         pct(totalIntl),
    pctPromocao:     items.length > 0 ? +((promo/items.length)*100).toFixed(1) : 0,
    precoMedio: avg,
    precoMin:   +minPrice.toFixed(2),
    precoMax:   +maxPrice.toFixed(2),
    mercadoEnderecavel: +(avg * total).toFixed(2),
    categories,
    topAnuncios,
  };
}

// ─── MODO FALLBACK: client_credentials → products/search ─────────────────────
async function buscarComAppToken(query, token) {
  const q = encodeURIComponent(query);

  const [ddRaw, ...prodPages] = await Promise.all([
    mlGet(`/sites/MLB/domain_discovery/search?q=${q}&limit=3`, token),
    ...Array.from({length:6}, (_,i) =>
      mlGet(`/products/search?site_id=MLB&q=${q}&limit=50&offset=${i*50}`, token)
    )
  ]);

  const categories = (ddRaw || []).map(d => ({ id: d.category_id, name: d.category_name }));
  const mainCat = categories[0] || null;

  const seen = new Set();
  const catalogIds = [];
  for (const page of prodPages) {
    for (const r of page?.results || []) {
      if (!seen.has(r.id)) { seen.add(r.id); catalogIds.push(r.id); }
    }
  }

  const [catData, itemResults] = await Promise.all([
    mainCat ? mlGet(`/categories/${mainCat.id}`, token) : Promise.resolve(null),
    pAll(catalogIds.map(pid => () => mlGet(`/products/${pid}/items?limit=3`, token)), 25)
  ]);

  const totalMercado = catData?.total_items_in_this_category || null;

  const allItems = [];
  for (const page of itemResults) {
    for (const r of page?.results || []) {
      const price = parseFloat(r.price || 0);
      if (price <= 0 || price > 500000) continue;
      allItems.push({
        price,
        originalPrice: r.original_price ? parseFloat(r.original_price) : null,
        freeShipping:  r.shipping?.free_shipping || false,
        fulfillment:   r.shipping?.logistic_type === 'fulfillment',
        official:      !!r.official_store_id,
        sellerId:      r.seller_id,
        international: r.international_delivery_mode != null && r.international_delivery_mode !== 'none',
        promo:         !!(r.original_price && parseFloat(r.original_price) > price),
        condition:     r.condition,
      });
    }
  }

  const n      = allItems.length || 1;
  const prices = allItems.map(i => i.price);
  const avg    = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;
  const sellers = new Set(allItems.map(i => i.sellerId).filter(Boolean));
  const pct    = v => +((v/n)*100).toFixed(1);

  const totalFull  = allItems.filter(i => i.fulfillment).length;
  const totalFrete = allItems.filter(i => i.freeShipping).length;
  const totalOfic  = allItems.filter(i => i.official).length;
  const totalIntl  = allItems.filter(i => i.international).length;
  const totalPromo = allItems.filter(i => i.promo).length;

  return {
    query, fonte: 'fallback_products_search',
    totalAnuncios:    totalMercado || catalogIds.length * 2,
    totalSampled:     allItems.length,
    totalSellers:     sellers.size,
    totalFull, totalFreteGratis: totalFrete,
    totalOficiais: totalOfic, totalLideres: 0,
    totalIntl, totalPromocao: totalPromo,
    pctFull:        pct(totalFull),
    pctFreteGratis: pct(totalFrete),
    pctOficiais:    pct(totalOfic),
    pctLideres:     0,
    pctIntl:        pct(totalIntl),
    pctPromocao:    pct(totalPromo),
    precoMedio: avg,
    precoMin:   prices.length ? +Math.min(...prices).toFixed(2) : 0,
    precoMax:   prices.length ? +Math.max(...prices).toFixed(2) : 0,
    mercadoEnderecavel: totalMercado ? +(avg * totalMercado).toFixed(2) : null,
    categories,
    topAnuncios: [],
    aviso: 'Modo fallback — métricas baseadas em buy-box. Faça login ML para dados completos.',
  };
}

// ─── Claude IA ────────────────────────────────────────────────────────────────
async function analisarComIA(m) {
  const isFallback = m.fonte === 'fallback_products_search';

  const top5txt = (m.topAnuncios || []).slice(0, 5).map(i =>
    `  - "${i.title}" | R$${i.price} | Full:${i.fulfillment} | Oficial:${i.isOficial}`
  ).join('\n') || '  (dados de buy-box apenas, sem títulos de anúncios)';

  const prompt = `Você é especialista sênior em inteligência de mercado para e-commerce Brasil (Mercado Livre).
Missão: identificar oportunidades reais com alta demanda e baixa saturação para revenda.

Produto: "${m.query}"
Categoria ML: ${m.categories?.[0]?.name || 'N/D'}
Fonte dos dados: ${isFallback ? 'buy-box winners (amostra parcial — dados estimados)' : 'catálogo completo ML via available_filters (dados reais)'}

DADOS DE MERCADO:
- Total anúncios (mercado real): ${(m.totalAnuncios||0).toLocaleString('pt-BR')}
- Amostrados para métricas: ${m.totalSampled}
- Vendedores únicos: ${m.totalSellers}
- Preço médio: R$ ${m.precoMedio}
- Faixa: R$ ${m.precoMin} — R$ ${m.precoMax}
- Mercado endereçável est.: ${m.mercadoEnderecavel ? 'R$ ' + m.mercadoEnderecavel.toLocaleString('pt-BR') : 'N/D'}

MÉTRICAS DE COMPETITIVIDADE:
- Full ML (fulfillment): ${m.pctFull}%
- Frete grátis: ${m.pctFreteGratis}%
- Lojas Oficiais: ${m.pctOficiais}%
- ML Líderes (gold+platinum): ${m.pctLideres}%${isFallback ? ' (N/D no modo fallback)' : ''}
- Internacional: ${m.pctIntl}%
- Em promoção: ${m.pctPromocao}%

TOP ANÚNCIOS:
${top5txt}

CRITÉRIOS:
Demanda — MUITO ALTA:>50k | ALTA:10k-50k | MÉDIA:2k-10k | BAIXA:<2k
Saturação — ALTA: Full>40% E Oficiais>30% | BAIXA: ambos <20%
Ticket ideal: R$80-300 é o sweet spot para revenda

${isFallback ? 'NOTA: dados parciais (buy-box only) — seja conservador nas métricas de % e deixe isso claro no resumo.' : ''}

Responda APENAS JSON válido, sem markdown:
{"score":<0-100>,"veredicto":"EXCELENTE|BOM|MODERADO|ARRISCADO|EVITAR","titulo":"<7 palavras>","resumo":"<2 frases diretas>","pontos_favor":["<com dado>","<com dado>","<com dado>"],"pontos_contra":["<risco>","<risco>"],"estrategia":"<3 ações concretas>","diferencial_sugerido":"<o que fazer diferente>","margem_estimada":"<ex:25-40%>","ticket_ideal":"<ex:R$ 80-150>","volume_minimo_mensal":"<ex:30-60 unidades>","saturacao":"BAIXA|MEDIA|ALTA","demanda":"BAIXA|MEDIA|ALTA|MUITO ALTA","concorrencia":"BAIXA|MEDIA|ALTA|MUITO ALTA","alerta":${isFallback ? '"Dados parciais (buy-box). Faça login ML no menu para análise completa."' : 'null'},"score_demanda":<0-100>,"score_saturacao":<0-100>,"score_margem":<0-100>}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
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

  if (!r.ok) throw new Error('Anthropic API ' + r.status);
  const data = await r.json();
  const txt  = data.content?.[0]?.text || '';
  const s    = txt.indexOf('{');
  const e    = txt.lastIndexOf('}');
  if (s === -1) throw new Error('IA sem JSON: ' + txt.slice(0, 100));
  return JSON.parse(txt.slice(s, e + 1));
}

// ─── POST /api/validar ────────────────────────────────────────────────────────
export async function handleValidar(req, res) {
  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query obrigatório' });

  try {
    const userToken = getUserToken();
    const appToken  = await getAppToken();

    let metricas;
    if (userToken) {
      console.log(`[DEXAN] "${query}" — OAuth user token ✅`);
      try {
        metricas = await buscarComOAuth(query.trim(), userToken);
      } catch (e) {
        console.warn('[DEXAN] OAuth falhou, usando fallback:', e.message);
        metricas = await buscarComAppToken(query.trim(), appToken);
      }
    } else {
      console.log(`[DEXAN] "${query}" — fallback client_credentials ⚠️`);
      metricas = await buscarComAppToken(query.trim(), appToken);
    }

    const analise = await analisarComIA(metricas);
    console.log(`[DEXAN] Score: ${analise.score} | ${analise.veredicto} | fonte: ${metricas.fonte}`);
    res.json({ metricas, analise, tokenMode: userToken ? 'oauth' : 'fallback' });

  } catch (err) {
    console.error('[DEXAN] handleValidar error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// ─── Legacy endpoints ─────────────────────────────────────────────────────────
export async function handleGetToken(req, res) {
  try {
    const token = await getAppToken();
    res.json({ access_token: token, expires_in: 21600 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleAnalyze(req, res) {
  return handleValidar(req, res);
}
