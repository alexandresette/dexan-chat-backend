// routes/validador.js — DEXAN Validador v1.0
// GET  /api/ml-token  → retorna token client_credentials ao browser
// POST /api/analyze   → recebe dados ML do browser, calcula métricas + IA

import Anthropic from '@anthropic-ai/sdk';

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

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
  const totalLideres     = ['gold', 'platinum'].reduce((a, id) =>
    a + getFilter('power_seller_status', id), 0);
  const totalIntl        = ((available_filters || []).find(x => x.id === 'item_location')?.values || [])
    .filter(v => v.id !== 'CBte' && v.id !== 'BR')
    .reduce((a, v) => a + (v.results || 0), 0);

  const items = results || [];
  const prices = items.map(i => parseFloat(i.price)).filter(p => p > 0 && p < 500000);
  const avgPrice = prices.length
    ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)
    : 0;
  const minPrice = prices.length ? +Math.min(...prices).toFixed(2) : 0;
  const maxPrice = prices.length ? +Math.max(...prices).toFixed(2) : 0;

  const sellers = new Set(items.map(i => i.seller?.id).filter(Boolean));
  const totalPromocao = items.filter(i => i.original_price && i.original_price > i.price).length;

  const pct = (n) => totalAnuncios > 0 ? +((n / totalAnuncios) * 100).toFixed(1) : 0;

  // Score de oportunidade pré-IA (heurísticas)
  // Demanda = volume de anúncios total
  // Saturação = % Full + % Líderes + % Oficiais
  const satScore = (pct(totalFull) * 0.4) + (pct(totalLideres) * 0.35) + (pct(totalOficiais) * 0.25);

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
    totalSellers:    sellers.size,
    totalPromocao1aPagina: totalPromocao,
    pctFull:         pct(totalFull),
    pctFreteGratis:  pct(totalFreteGratis),
    pctOficiais:     pct(totalOficiais),
    pctLideres:      pct(totalLideres),
    pctIntl:         pct(totalIntl),
    pctPromocao:     items.length > 0 ? +((totalPromocao / items.length) * 100).toFixed(1) : 0,
    precoMedio:      avgPrice,
    precoMin:        minPrice,
    precoMax:        maxPrice,
    mercadoEnderecavel: +(avgPrice * totalAnuncios).toFixed(2),
    satScore:        +satScore.toFixed(1),
    topAnuncios,
  };
}

// ─── Análise com Claude IA ────────────────────────────────────────────────────
async function analisarComIA(query, metricas) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const top5 = metricas.topAnuncios.slice(0, 5).map(i =>
    `  - "${i.title}" | R$${i.price} | Full:${i.fulfillment} | Oficial:${i.isOficial} | Promo:${i.isPromocao}`
  ).join('\n');

  const prompt = `Você é um especialista sênior em inteligência de mercado para e-commerce Brasil, com foco em Mercado Livre.
Sua missão: identificar oportunidades reais de revenda com alta demanda e baixa saturação.

Produto analisado: "${query}"

═══ DADOS REAIS DO MERCADO LIVRE ═══
• Total de anúncios:      ${metricas.totalAnuncios.toLocaleString('pt-BR')}
• Vendedores únicos:      ${metricas.totalSellers}
• Preço médio:            R$ ${metricas.precoMedio}
• Faixa de preço:         R$ ${metricas.precoMin} — R$ ${metricas.precoMax}
• Mercado endereçável:    R$ ${metricas.mercadoEnderecavel?.toLocaleString('pt-BR')}

• Full ML (fulfillment):  ${metricas.pctFull}% (${metricas.totalFull} anúncios)
• Frete grátis:           ${metricas.pctFreteGratis}% (${metricas.totalFreteGratis} anúncios)
• Lojas oficiais:         ${metricas.pctOficiais}% (${metricas.totalOficiais} anúncios)
• ML Líderes (gold/plat): ${metricas.pctLideres}% (${metricas.totalLideres} anúncios)
• Internacional:          ${metricas.pctIntl}%

TOP 5 ANÚNCIOS RELEVANTES:
${top5}

═══ CRITÉRIOS DE AVALIAÇÃO ═══
DEMANDA:
  - MUITO ALTA: >50k anúncios
  - ALTA: 10k-50k
  - MÉDIA: 2k-10k
  - BAIXA: <2k

SATURAÇÃO (quão difícil é competir):
  - ALTA: Full>40% E Líderes>30% — grandes players dominam
  - MÉDIA: Full 20-40% OU Líderes 15-30%
  - BAIXA: Full<20% E Líderes<15% — espaço para novos entrantes

TICKET IDEAL para revenda (margem suficiente):
  - <R$30: muito difícil (frete come margem)
  - R$30-80: viável com cuidado
  - R$80-300: faixa ideal
  - >R$300: bom, mas capital de giro maior

Responda APENAS em JSON válido, sem markdown, sem texto fora do JSON:
{
  "score": <inteiro 0-100 — oportunidade geral>,
  "veredicto": "EXCELENTE|BOM|MODERADO|ARRISCADO|EVITAR",
  "titulo": "<resumo em até 7 palavras>",
  "resumo": "<2 frases diretas e objetivas sobre a oportunidade>",
  "pontos_favor": ["<ponto específico com dado>", "<ponto específico>", "<ponto específico>"],
  "pontos_contra": ["<risco concreto>", "<risco concreto>"],
  "estrategia": "<3 ações concretas e específicas para entrar nesse mercado com sucesso>",
  "diferencial_sugerido": "<o que fazer de diferente dos concorrentes atuais>",
  "margem_estimada": "<ex: 25-40%>",
  "ticket_ideal": "<ex: R$ 45-90>",
  "volume_minimo_mensal": "<ex: 20-50 unidades para viabilizar>",
  "saturacao": "BAIXA|MEDIA|ALTA",
  "demanda": "BAIXA|MEDIA|ALTA|MUITO ALTA",
  "concorrencia": "BAIXA|MEDIA|ALTA|MUITO ALTA",
  "alerta": "<null ou string com alerta crítico se houver>",
  "score_demanda": <0-100>,
  "score_saturacao": <0-100 — 100 = muito saturado>,
  "score_margem": <0-100>
}`;

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });

  const txt = resp.content?.[0]?.text || '';
  const s = txt.indexOf('{');
  const e = txt.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('IA não retornou JSON válido');
  return JSON.parse(txt.slice(s, e + 1));
}

// ─── POST /api/analyze ────────────────────────────────────────────────────────
export async function handleAnalyze(req, res) {
  const { query, mlData } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query obrigatório' });
  if (!mlData) return res.status(400).json({ error: 'mlData obrigatório' });

  try {
    console.log(`[DEXAN Validador] Analisando: "${query}"`);
    const metricas = calcularMetricas(mlData);
    const analise  = await analisarComIA(query, metricas);
    console.log(`[DEXAN Validador] Score: ${analise.score} | Veredicto: ${analise.veredicto}`);
    res.json({ metricas, analise });
  } catch (err) {
    console.error('[DEXAN] Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
