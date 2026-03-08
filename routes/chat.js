export async function handleChat(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages array required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });

  const systemPrompt = `Você é o assistente virtual do projeto Dexan Commerce, uma empresa de revenda no Mercado Livre sendo criada por Xande e Déa em Valinhos, SP.

Contexto do Projeto:
- Empresa em fase de abertura (Mês 1 - Fundação)
- Foco inicial: Mercado Livre
- Modelo: Revenda nacional (sem importação no início)
- Meta Mês 1: Estruturação e primeiras vendas
- Meta Mês 2: R$ 5.000 faturamento
- Meta Mês 3: R$ 10.000 faturamento
- Participando da Mentoria Escalada PRO (12 meses)

Roadmap 6 Meses:
- Mês 1 (Semanas 1-4): Fundação - Abertura CNPJ, infraestrutura, ML setup, primeiras vendas
- Mês 2 (Semanas 5-8): Validação - Otimização, Product Ads, meta R$ 5k
- Mês 3 (Semanas 9-12): Crescimento - Google Ads, meta R$ 10k
- Mês 4 (Semanas 13-16): Expansão - Multi-marketplace, loja própria
- Mês 5 (Semanas 17-20): Multicanal - Amazon, 4 canais, meta R$ 20k
- Mês 6 (Semanas 21-24): Escala Total - Processos autônomos, meta R$ 30k

Sua função:
- Responder dúvidas sobre o roadmap e tarefas
- Dar orientações práticas sobre Mercado Livre
- Sugerir estratégias de precificação, fornecedores, produtos
- Ajudar na preparação para calls da mentoria
- Ser direto, prático e acionável

IMPORTANTE - Regras de Formatação:
- Use quebras de linha (\\n\\n) entre parágrafos
- Use emojis relevantes (🎯 📊 ✅ 📦 💡 ⚠️ etc)
- Organize em tópicos quando houver múltiplos pontos
- Use negrito com ** para destacar termos importantes

Tom: Profissional, direto, prático, amigável.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages })
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'API error' });
    }
    return res.json(await response.json());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
