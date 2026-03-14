// routes/validador.js — DEXAN Validador v2.0
// Arquitetura: full backend proxy — sem chamadas ML do browser
// POST /api/validar  → recebe { query } → faz tudo no backend → retorna métricas + IA

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;

// ─── Token cache ──────────────────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiry  = 0;

async function getMLToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
  });
  if (!r.ok) throw new Error('Token ML falhou: ' + r.status);
  const d = await r.json();
  _cachedToken  = d.access_token;
  _tokenExpiry  = Date.now() + (d.expires_in - 300) * 1000;
  return _cachedToken;
}

async function mlGet(path, token) {
  const r = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!r.ok) return null;
  return r.json();
}

// Parallel executor with concurrency cap
async function pAll(tasks, concurrency = 20) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn().catch(() => null)));
    results.push(...batch);
  }
  return results;
}

// ─── Busca completa de mercado (tudo no backend) ──────────────────────────────
async function buscarMercado(query) {
  const token = await getMLToken();
  const q = encodeURIComponent(query);

  // Fase 1: em paralelo — domain_discovery + 6 páginas de products/search
  const offsets = [0, 50, 100, 150, 200, 250];
  const [ddRaw, ...prodPages] = await Promise.all([
    mlGet(`/sites/MLB/domain_discovery/search?q=${q}&limit=3`, token),
    ...offsets.map(o => mlGet(`/products/search?site_id=MLB&q=${q}&limit=50&offset=${o}`, token))
  ]);

  const categories = (ddRaw || []).map(d => ({
    id: d.category_id, name: d.category_name, domain: d.domain_id
  }));
  const mainCat = categories[0] || null;

  // Coleta todos os catalog product IDs
  const seen = new Set();
  const catalogIds = [];
  for (const page of prodPages) {
    for (const r of page?.results || []) {
      if (!seen.has(r.id)) { seen.add(r.id); catalogIds.push(r.id); }
    }
  }

  // Fase 2: em paralelo — category total + items de cada catalog product
  const catTask = mainCat
    ? mlGet(`/categories/${mainCat.id}`, token)
    : Promise.resolve(null);

  const itemTasks = catalogIds.map(pid => () =>
    mlGet(`/products/${pid}/items?limit=3`, token)
  );

  const [catData, ...itemResults] = await Promise.all([
    catTask,
    ...await pAll(itemTasks, 25).then(r => [Promise.resolve(r)])
  ]);

  const totalMercado = catData?.total_items_in_this_category || null;

  // Extrai items reais das respostas
  const allItems = [];
  const itemResultsFlat = (itemResults[0] || []);
  for (const page of itemResultsFlat) {
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
        itemId:        r.item_id,
      });
    }
  }

  const n = allItems.length || 1;
  const prices = allItems.map(i => i.price);
  const avgPrice  = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;
  const minPrice  = prices.length ? +Math.min(...prices).toFixed(2) : 0;
  const maxPrice  = prices.length ? +Math.max(...prices).toFixed(2) : 0;

  const totalFull   = allItems.filter(i => i.fulfillment).length;
  const totalFrete  = allItems.filter(i => i.freeShipping).length;
  const totalOfic   = allItems.filter(i => i.official).length;
  const totalIntl   = allItems.filter(i => i.international).length;
  const totalPromo  = allItems.filter(i => i.promo).length;
  const sellers     = new Set(allItems.map(i => i.sellerId).filter(Boolean));

  const pct = v => n > 0 ? +((v/n)*100).toFixed(1) : 0;

  // Top anúncios (melhores preços com mais dados)
  const topAnuncios = allItems.slice(0, 8).map(i => ({
    price:         i.price,
    originalPrice: i.originalPrice,
    freeShipping:  i.freeShipping,
    fulfillment:   i.fulfillment,
    isOficial:     i.official,
    isPromocao:    i.promo,
    condition:     i.condition,
  }));

  return {
    query,
    totalAnuncios:    totalMercado || (catalogIds.length * 3),
    totalSampled:     allItems.length,
    totalSellers:     sellers.size,
    totalFull,
    totalFreteGratis: totalFrete,
    totalOficiais:    totalOfic,
    totalIntl,
    totalPromocao:    totalPromo,
    pctFull:          pct(totalFull),
    pctFreteGratis:   pct(totalFrete),
    pctOficiais:      pct(totalOfic),
    pctLideres:       0, // não disponível sem sites/MLB/search
    pctIntl:          pct(totalIntl),
    pctPromocao:      pct(totalPromo),
    precoMedio:       avgPrice,
    precoMin:         minPrice,
    precoMax:         maxPrice,
    mercadoEnderecavel: totalMercado ? +(avgPrice * totalMercado).toFixed(2) : null,
    categories,
    topAnuncios,
    fonte: 'ml_backend_v2_proxy',
  };
}

// ─── Claude IA via fetch ──────────────────────────────────────────────────────
async function analisarComIA(m) {
  const prompt = `Você é especialista sênior em inteligência de mercado para e-commerce Brasil (Mercado Livre).
Missão: identificar oportunidades reais com alta demanda e baixa saturação para revenda.

Produto: "${m.query}"
Categoria ML: ${m.categories?.[0]?.name || 'N/D'}

DADOS REAIS DO MERCADO:
- Total de anúncios (mercado real): ${(m.totalAnuncios||0).toLocaleString('pt-BR')}
- Anúncios amostrados para métricas: ${m.totalSampled}
- Vendedores únicos na amostra: ${m.totalSellers}
- Preço médio: R$ ${m.precoMedio}
- Faixa de preço: R$ ${m.precoMin} — R$ ${m.precoMax}
- Mercado endereçável est: ${m.mercadoEnderecavel ? 'R$ ' + m.mercadoEnderecavel.toLocaleString('pt-BR') : 'N/D'}

MÉTRICAS DE COMPETITIVIDADE (da amostra):
- Full ML (fulfillment): ${m.pctFull}% → ${m.pctFull > 40 ? 'grandes players dominam logística' : m.pctFull > 20 ? 'fulfillment em crescimento' : 'espaço para crescer'}
- Frete grátis: ${m.pctFreteGratis}% → ${m.pctFreteGratis > 60 ? 'obrigatório para competir' : 'diferencial possível'}
- Lojas Oficiais: ${m.pctOficiais}% → ${m.pctOficiais > 30 ? 'marcas presentes, difícil competir' : 'espaço para revendedores'}
- Internacional: ${m.pctIntl}% → ${m.pctIntl > 20 ? 'produto importado dominante' : 'mercado local viável'}
- Em promoção: ${m.pctPromocao}% → ${m.pctPromocao > 40 ? 'guerra de preços' : 'margem preservada'}

CRITÉRIOS DE AVALIAÇÃO:
Demanda total: MUITO ALTA>50k | ALTA:10k-50k | MÉDIA:2k-10k | BAIXA:<2k
Saturação: ALTA se Full>40% E Oficiais>30% | BAIXA se ambos <20%
Ticket ideal: <R$30=difícil | R$30-80=cuidado | R$80-300=ideal | >R$300=capital maior

Responda APENAS JSON válido, sem markdown:
{"score":<0-100>,"veredicto":"EXCELENTE|BOM|MODERADO|ARRISCADO|EVITAR","titulo":"<7 palavras>","resumo":"<2 frases diretas>","pontos_favor":["<dado concreto>","<dado concreto>","<dado concreto>"],"pontos_contra":["<risco real>","<risco real>"],"estrategia":"<3 ações concretas para entrar nesse mercado>","diferencial_sugerido":"<o que fazer diferente dos atuais>","margem_estimada":"<ex:25-40%>","ticket_ideal":"<ex:R$ 80-150>","volume_minimo_mensal":"<ex:30-60 unidades>","saturacao":"BAIXA|MEDIA|ALTA","demanda":"BAIXA|MEDIA|ALTA|MUITO ALTA","concorrencia":"BAIXA|MEDIA|ALTA|MUITO ALTA","alerta":null,"score_demanda":<0-100>,"score_saturacao":<0-100>,"score_margem":<0-100>}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:    'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!r.ok) throw new Error('Anthropic API ' + r.status);
  const data = await r.json();
  const txt  = data.content?.[0]?.text || '';
  const s    = txt.indexOf('{');
  const e    = txt.lastIndexOf('}');
  if (s === -1) throw new Error('IA sem JSON: ' + txt.slice(0, 80));
  return JSON.parse(txt.slice(s, e + 1));
}

// ─── POST /api/validar ────────────────────────────────────────────────────────
export async function handleValidar(req, res) {
  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query obrigatório' });

  try {
    console.log(`[DEXAN] Validando: "${query}"`);
    const metricas = await buscarMercado(query.trim());
    const analise  = await analisarComIA(metricas);
    console.log(`[DEXAN] OK: score=${analise.score} | ${analise.veredicto}`);
    res.json({ metricas, analise });
  } catch (err) {
    console.error('[DEXAN] handleValidar error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Legacy — mantém retrocompatibilidade com endpoints anteriores
export async function handleGetToken(req, res) {
  try {
    const token = await getMLToken();
    res.json({ access_token: token, expires_in: 21600 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleAnalyze(req, res) {
  // Redireciona para o novo fluxo completo se vier query + mlData legado
  const { query, mlData } = req.body || {};
  if (query && !mlData) return handleValidar(req, res);
  if (!query) return res.status(400).json({ error: 'query obrigatório' });

  // Aceita mlData do browser (caso alguém ainda use o fluxo antigo)
  try {
    const metricas = calcularMetricasLegado(mlData, query);
    const analise  = await analisarComIA(metricas);
    res.json({ metricas, analise });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function calcularMetricasLegado(mlData, query) {
  const { paging, results, available_filters } = mlData || {};
  const totalAnuncios = paging?.total || 0;
  const getF = (id, vid) => {
    const f = (available_filters || []).find(x => x.id === id);
    if (!f) return 0;
    return vid ? f.values.find(v => v.id === vid)?.results || 0
               : f.values.reduce((a,v) => a+(v.results||0), 0);
  };
  const totalFull   = getF('fulfillment','fulfillment');
  const totalFrete  = getF('free_shipping','yes');
  const totalOfic   = getF('official_store');
  const totalLideres= ['gold','platinum'].reduce((a,id)=>a+getF('power_seller_status',id),0);
  const totalIntl   = ((available_filters||[]).find(x=>x.id==='item_location')?.values||[])
    .filter(v=>v.id!=='CBte'&&v.id!=='BR').reduce((a,v)=>a+(v.results||0),0);
  const items = results||[];
  const prices = items.map(i=>parseFloat(i.price)).filter(p=>p>0&&p<500000);
  const avg = prices.length ? +(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : 0;
  const pct = v => totalAnuncios>0 ? +((v/totalAnuncios)*100).toFixed(1) : 0;
  return {
    query, totalAnuncios, totalSampled: items.length,
    totalSellers: new Set(items.map(i=>i.seller?.id).filter(Boolean)).size,
    totalFull, totalFreteGratis:totalFrete, totalOficiais:totalOfic, totalIntl, totalPromocao:0,
    pctFull:pct(totalFull), pctFreteGratis:pct(totalFrete), pctOficiais:pct(totalOfic),
    pctLideres:pct(totalLideres), pctIntl:pct(totalIntl), pctPromocao:0,
    precoMedio:avg, precoMin:prices.length?+Math.min(...prices).toFixed(2):0,
    precoMax:prices.length?+Math.max(...prices).toFixed(2):0,
    mercadoEnderecavel:+(avg*totalAnuncios).toFixed(2),
    categories:[], topAnuncios: items.slice(0,8).map(i=>({
      title:i.title, price:parseFloat(i.price), freeShipping:i.shipping?.free_shipping,
      fulfillment:i.shipping?.logistic_type==='fulfillment', isOficial:!!i.official_store_id,
      isPromocao:!!(i.original_price&&i.original_price>i.price), thumbnail:i.thumbnail, link:i.permalink
    })), fonte:'legado_browser_mldata'
  };
}
