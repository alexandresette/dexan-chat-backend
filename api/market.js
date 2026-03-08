// api/market.js — Backend Vercel para busca de dados de mercado
// Deploy em: github.com/alexandresette/dexan-chat-backend
// Endpoint: https://dexan-chat-backend.vercel.app/api/market

export default async function handler(req, res) {
  // CORS — permite chamadas do roadmap DEXAN
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { product, source } = req.body;
  if (!product || !source) return res.status(400).json({ error: 'Missing product or source' });

  try {
    // ── SERPAPI — Google Shopping BR ──────────────────────
    if (source === 'serpapi') {
      const key = process.env.SERPAPI_KEY;
      if (!key) return res.status(200).json({ error: 'SERPAPI_KEY não configurada no Vercel', nokey: true });

      const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(product)}&gl=br&hl=pt&num=10&api_key=${key}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('SerpApi HTTP ' + resp.status);
      const data = await resp.json();

      const items = (data.shopping_results || []).slice(0, 6);
      if (!items.length) return res.status(200).json({ error: 'Nenhum resultado no Google Shopping BR' });

      const prices = items
        .filter(i => i.price)
        .map(i => parseFloat(String(i.price).replace(/[^0-9,.]/g, '').replace(',', '.')))
        .filter(n => !isNaN(n) && n > 0);

      return res.status(200).json({
        items: items.map(i => ({
          title: i.title?.slice(0, 60) || '',
          price: i.price || '',
          rating: i.rating || null,
          reviews: i.reviews || null,
          source: i.source || '',
        })),
        avgPrice: prices.length ? Math.round(prices.reduce((a, b) => a + b) / prices.length) : null,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        count: items.length,
      });
    }

    // ── REDDIT — API pública JSON ──────────────────────────
    if (source === 'reddit') {
      // Tenta 3 queries diferentes para maximizar resultado
      const queries = [
        `${product} Brasil comprar`,
        `${product} mercado livre`,
        `${product}`,
      ];

      let allPosts = [];
      for (const q of queries) {
        try {
          const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=relevance&limit=8&t=year`;
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'DEXAN-Radar/3.0 (market research tool)' }
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          const posts = (data.data?.children || []).map(p => ({
            title: p.data.title.slice(0, 80) + (p.data.title.length > 80 ? '...' : ''),
            sub: p.data.subreddit,
            ups: p.data.ups,
            comments: p.data.num_comments,
            date: new Date(p.data.created_utc * 1000).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }),
            url: `https://reddit.com${p.data.permalink}`,
          }));
          allPosts = [...allPosts, ...posts];
          if (allPosts.length >= 5) break;
        } catch (e) { continue; }
      }

      // Deduplica por título
      const seen = new Set();
      const unique = allPosts.filter(p => {
        if (seen.has(p.title)) return false;
        seen.add(p.title);
        return true;
      }).slice(0, 6);

      if (!unique.length) return res.status(200).json({ error: 'Nenhuma discussão encontrada no Reddit' });

      const totalEngagement = unique.reduce((a, p) => a + p.ups + p.comments, 0);
      const buzzLevel = totalEngagement > 5000 ? 'alto' : totalEngagement > 500 ? 'médio' : 'baixo';

      return res.status(200).json({
        posts: unique,
        totalEngagement,
        buzzLevel,
        totalPosts: unique.length,
      });
    }

    // ── YOUTUBE — via Google API (server-side, sem CORS) ───
    if (source === 'youtube') {
      const key = process.env.YOUTUBE_KEY;
      if (!key) return res.status(200).json({ error: 'YOUTUBE_KEY não configurada no Vercel', nokey: true });

      // Duas queries: PT-BR e busca por review
      const queries = [
        `${product} comprar vale a pena`,
        `${product} review brasil`,
      ];

      let allItems = [];
      for (const q of queries) {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&relevanceLanguage=pt&regionCode=BR&maxResults=6&order=viewCount&key=${key}`;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        allItems = [...allItems, ...(data.items || [])];
        if (allItems.length >= 6) break;
      }

      if (!allItems.length) return res.status(200).json({ error: 'Nenhum vídeo encontrado' });

      // Busca stats
      const ids = [...new Set(allItems.map(i => i.id.videoId))].slice(0, 8).join(',');
      const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${key}`;
      const statsResp = await fetch(statsUrl);
      const statsData = await statsResp.json();
      const statsMap = {};
      (statsData.items || []).forEach(v => { statsMap[v.id] = v.statistics; });

      // Filtra para PT-BR relevantes e ordena por views
      const videos = allItems
        .slice(0, 8)
        .map(v => {
          const stats = statsMap[v.id.videoId] || {};
          const views = parseInt(stats.viewCount || 0);
          return {
            title: v.snippet.title.slice(0, 60) + (v.snippet.title.length > 60 ? '...' : ''),
            channel: v.snippet.channelTitle,
            views,
            viewsStr: views > 1000000 ? (views / 1000000).toFixed(1) + 'M' : views > 1000 ? (views / 1000).toFixed(0) + 'K' : views.toString(),
            date: v.snippet.publishedAt.slice(0, 7),
            videoId: v.id.videoId,
          };
        })
        .sort((a, b) => b.views - a.views)
        .slice(0, 4);

      const avgViews = videos.length ? Math.round(videos.reduce((a, v) => a + v.views, 0) / videos.length) : 0;
      const buzzLevel = avgViews > 500000 ? 'alto' : avgViews > 50000 ? 'médio' : avgViews > 5000 ? 'baixo' : 'mínimo';

      return res.status(200).json({
        videos,
        totalVideos: allItems.length,
        avgViews,
        buzzLevel,
      });
    }

    return res.status(400).json({ error: 'source inválido. Use: serpapi | reddit | youtube' });

  } catch (err) {
    console.error('[market.js]', err);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
