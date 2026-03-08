// api/market.js — DEXAN Backend v4
// ML data via SerpApi Google Shopping BR (filtra resultados do ML + demais)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { product, source } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product required' });

  try {
    if (source === 'mercadolivre') {
      return res.json(await fetchMLData(product));
    }
    return res.status(400).json({ error: 'source inválida. Use: mercadolivre' });
  } catch (err) {
    console.error('market error:', err);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}

// ── ML DATA via SerpApi Google Shopping BR ────────────────
// Google Shopping BR retorna ~20-40% dos resultados do ML naturalmente
// Completamos com busca direta "site:mercadolivre.com.br"
async function fetchMLData(product) {
  const serpKey = process.env.SERPAPI_KEY;
  if (!serpKey) {
    return { error: 'SERPAPI_KEY não configurada', nokey: true, totalItems: 0 };
  }

  const q = encodeURIComponent(product);

  // Busca 1: Google Shopping BR geral (40 resultados inclui ML, Shopee, Amazon BR etc)
  const url1 = `https://serpapi.com/search.json?engine=google_shopping&q=${q}&gl=br&hl=pt-BR&location=Brazil&api_key=${serpKey}&num=40`;

  const r1 = await fetch(url1);
  if (!r1.ok) throw new Error('SerpApi error: ' + r1.status);
  const d1 = await r1.json();
  if (d1.error) throw new Error(d1.error);

  const allItems = d1.shopping_results || [];
  if (!allItems.length) return { error: 'Nenhum resultado encontrado', totalItems: 0 };

  // Separar ML dos outros
  const mlItems = allItems.filter(i =>
    String(i.source || '').toLowerCase().includes('mercado')
  );
  const otherItems = allItems.filter(i =>
    !String(i.source || '').toLowerCase().includes('mercado')
  );

  // Usar ML se tiver suficiente, senão usar todos
  const primaryItems = mlItems.length >= 3 ? mlItems : allItems;

  const extractPrice = (p) => {
    if (!p) return null;
    if (typeof p === 'number') return p;
    // Formatos: "R$ 108,40" ou "R$ 385,82 agora" ou "R$108.40"
    const clean = String(p).replace(/[^\d,\.]/g, '').replace(',', '.');
    const val = parseFloat(clean);
    return val > 0 ? val : null;
  };

  const prices = primaryItems.map(i => extractPrice(i.price)).filter(p => p && p > 0 && p < 50000);
  if (!prices.length) return { error: 'Sem preços válidos', totalItems: 0 };

  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  // Top sellers com dados enriquecidos
  const topSellers = primaryItems.slice(0, 6).map(i => ({
    title: i.title || 'Produto',
    price: extractPrice(i.price),
    soldQuantity: null, // Shopping não expõe vendas
    rating: i.rating ? parseFloat(i.rating) : null,
    reviews: i.reviews || null,
    freeShipping: false,
    source: i.source || 'Google Shopping',
    isML: String(i.source || '').toLowerCase().includes('mercado'),
    link: i.link || null
  }));

  // Estimar total de anúncios ML baseado na proporção
  const totalInSearch = d1.search_information?.total_results || allItems.length;
  const mlProportion = allItems.length > 0 ? mlItems.length / allItems.length : 0.3;
  const estimatedMLTotal = mlItems.length >= 3
    ? Math.round(totalInSearch * mlProportion)
    : allItems.length;

  return {
    source: 'google_shopping_br',
    mlItemsFound: mlItems.length,
    totalItems: estimatedMLTotal,
    query: product,
    prices: {
      avg: parseFloat(avgPrice.toFixed(2)),
      min: parseFloat(Math.min(...prices).toFixed(2)),
      max: parseFloat(Math.max(...prices).toFixed(2))
    },
    freeShippingPct: 0,
    topSellers,
    competitorSources: [...new Set(allItems.map(i => i.source).filter(Boolean))].slice(0, 6),
    timestamp: new Date().toISOString()
  };
}
