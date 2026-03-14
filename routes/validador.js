// routes/validador.js — DEXAN Validador v1.1
// GET  /api/ml-token  → retorna token client_credentials ao browser
// POST /api/analyze   → recebe dados ML do browser, calcula métricas + IA (via fetch nativo)

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;

// ─── Token cache ──────────────────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

async function getMLToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`
  });
  if (!resp.ok) throw new Error('Falha ao obter token ML: ' + resp.status);
  const d = await resp.json();
  _cachedToken = d.access_token;
  _tokenExpiry = Date.now() + (d.expires_in - 300) * 1000;
  console.log('[DEXAN] Token ML renovado via client_credentials');
  return _cachedToken;
}

// ─── GET /api/ml-token ────────────────────────────────────────────────────────
export async function handleGetToken(req, res) {
  try {
    const token = await getMLToken();
    res.json({ access_token: token, expires_in: 21600 });
  } catch (err) {
    console.error('[DEXAN] Erro token:', err.message);
    res.status(500).json({ error: 'Falha ao obter token ML', detail: err.message });
  }
}

// ─── Calcular métricas a partir dos dados brutos do ML ───────────────────────
function calcularMetricas(mlData) {
  const { paging, results, available_filters } = mlData;
  const totalAnuncios = paging?.total || 0;

  const getFilter = (id, valueId) => {
    const f = (available_filters || []).find(x => x.id === id);
    if (!f) return 0;
    if (valueId) return f.values.find(v => v.id === valueId)?.results || 0;
    return f.values.reduce((a, v) => a + (v.results || 0), 0);
  };

  const totalFull        = getFilter('fulfillment', 'fulfillment');
  const totalFreteGratis = getFilter('free_shipping', 'yes');
  const totalOficiais    = getFilter('official_store');
  const totalLideres     = ['gold', 'platinum'].reduce((a, id) => a + getFilter('power_seller_status', id), 0);
  const totalIntl        = ((available_filters || []).find(x => x.id === 'item_location')?.values || [])
    .filter(v => v.id !== 'CBte' && v.id !== 'BR')
    .reduce((a, v) => a + (v.results || 0), 0);

  const items  = results || [];
  const prices = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 500000);
  const avgPrice = prices.length ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : 0;
  const minPrice = prices.length ? +Math.min(...prices).toFixed(2) : 0;
  const maxPrice = prices.length ? +Math.max(...prices).toFixed(2) : 0;

  const sellers      = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalPromocao = items.filter(i => i.original_price && i.original_price > i.price).length;

  const pct = n => totalAnuncios > 0 ? +((n / totalAnuncios) * 100).toFixed(1) : 0;

  const topAnuncios = items.slice(0, 10).map(i => ({
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
    seller:        { id: i.seller?.id, nickname: i.seller?.nickname }
  }));

  return {
    totalAnuncios,
    totalFull,
    totalFreteGratis,
    totalOficiais,
    totalLideres,
    totalIntl,
    totalSellers:          sellers.size,
    totalPromocao1aPagina: totalPromocao,
    pctFull:               pct(totalFull),
    pctFreteGratis:        pct(totalFreteGratis),
    pctOficiais:           pct(totalOficiais),
    pctLideres:            pct(totalLideres),
    pctIntl:               pct(totalIntl),
    pctPromocao:           items.length > 0 ? +((totalPromocao / items.length) * 100).toFixed(1) : 0,
    precoMedio:            avgPrice,
    precoMin:              minPrice,
    precoMax:              maxPrice,
    mercadoEnderecavel:    +(avgPrice * totalAnuncios).toFixed(2),
    topAnuncios,
  };
}

// ─── Análise com Claude via fetch nativo ─────────────────────────────────────
async function analisarComIA(query, m) {
  const top5 = m.topAnuncios.slice(0, 5).map(i =>
    `  - "${i.title}" | R$${i.price} | Full:${i.fulfillment} | Oficial:${i.isOficial} | Promo:${i.isPromocao}`
  ).join('\n');

  const prompt = `Você é especialista sênior em inteligência de mercado para e-commerce Brasil (Mercado Livre).
Identifique oportunidades com alta demanda e baixa saturação.

Produto: "${query}"

DADOS REAIS ML:
- Total anúncios: ${m.totalAnuncios.toLocaleString('pt-BR')}
- Vendedores únicos: ${m.totalSellers}
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
Demanda — MUITO ALTA:>50k | ALTA:10k-50k | MÉDIA:2k-10k | BAIXA:<2k
Saturação — ALTA: Full>40% E Líderes>30% | MÉDIA: intermediário | BAIXA: espaço para novos
Ticket ideal para revenda: R$80-300 é ideal; <R$30 é difícil; >R$300 exige capital

Responda APENAS JSON válido sem markdown:
{"score":<0-100>,"veredicto":"EXCELENTE|BOM|MODERADO|ARRISCADO|EVITAR","titulo":"<7 palavras>","resumo":"<2 frases objetivas>","pontos_favor":["<com dado>","<com dado>","<com dado>"],"pontos_contra":["<risco>","<risco>"],"estrategia":"<3 ações concretas>","diferencial_sugerido":"<o que fazer diferente>","margem_estimada":"<ex:25-40%>","ticket_ideal":"<ex:R$ 45-90>","volume_minimo_mensal":"<ex:20-50 unidades>","saturacao":"BAIXA|MEDIA|ALTA","demanda":"BAIXA|MEDIA|ALTA|MUITO ALTA","concorrencia":"BAIXA|MEDIA|ALTA|MUITO ALTA","alerta":null,"score_demanda":<0-100>,"score_saturacao":<0-100>,"score_margem":<0-100>}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages:   [{ role: 'user', content: prompt }]
    })
  });

  if (!resp.ok) {
    const e = await resp.text();
    throw new Error('Anthropic API ' + resp.status + ': ' + e.slice(0, 200));
  }

  const data = await resp.json();
  const txt  = data.content?.[0]?.text || '';
  const s    = txt.indexOf('{');
  const e    = txt.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('IA não retornou JSON válido: ' + txt.slice(0, 100));
  return JSON.parse(txt.slice(s, e + 1));
}

// ─── POST /api/analyze ────────────────────────────────────────────────────────
export async function handleAnalyze(req, res) {
  const { query, mlData } = req.body || {};
  if (!query)  return res.status(400).json({ error: 'query obrigatório' });
  if (!mlData) return res.status(400).json({ error: 'mlData obrigatório' });

  try {
    console.log(`[DEXAN Validador] Analisando: "${query}"`);
    const metricas = calcularMetricas(mlData);
    const analise  = await analisarComIA(query, metricas);
    console.log(`[DEXAN Validador] Score: ${analise.score} | ${analise.veredicto}`);
    res.json({ metricas, analise });
  } catch (err) {
    console.error('[DEXAN] Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
