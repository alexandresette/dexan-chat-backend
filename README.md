# 🚀 Dexan Chat Backend - Vercel Deployment

Backend serverless para o Chat Dexan, usando Anthropic Claude API.

## 📋 O QUE É

Este backend funciona como **proxy seguro** entre o chat frontend e a API da Anthropic:
- ✅ Esconde sua API Key (fica no servidor)
- ✅ Resolve problema de CORS
- ✅ Serverless (grátis na Vercel)
- ✅ Deploy automático

---

## 🚀 DEPLOY RÁPIDO (5 MINUTOS)

### **1. Criar Repositório no GitHub**

```bash
# No terminal, na pasta dexan-chat-backend:
git init
git add .
git commit -m "Initial commit - Dexan chat backend"
```

Depois no GitHub:
1. Vá em: https://github.com/new
2. Nome: `dexan-chat-backend`
3. Público ou Privado (tanto faz)
4. **NÃO** adicione README, .gitignore, license
5. Create repository

```bash
# Cole os comandos que o GitHub mostrar:
git remote add origin https://github.com/SEU-USUARIO/dexan-chat-backend.git
git branch -M main
git push -u origin main
```

---

### **2. Deploy na Vercel**

1. Acesse: https://vercel.com
2. **Sign up / Login** com GitHub
3. **Import Project**
4. Selecione: `dexan-chat-backend`
5. **NÃO configure nada ainda**
6. Clique **Deploy**

---

### **3. Adicionar API Key (Variável de Ambiente)**

Após o deploy:

1. No dashboard da Vercel, clique no projeto
2. **Settings** → **Environment Variables**
3. Adicione:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-api03-XXXXX` (sua key real)
   - **Environment:** Production, Preview, Development (marcar todos)
4. **Save**

5. **Redeploy:**
   - Vá em **Deployments**
   - Clique nos 3 pontinhos do último deploy
   - **Redeploy**

---

### **4. Testar o Endpoint**

Sua API estará em:
```
https://seu-projeto.vercel.app/api/chat
```

Teste:
```bash
curl -X POST https://seu-projeto.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Olá, teste!"}
    ]
  }'
```

Se retornar resposta do Claude → ✅ Funcionando!

---

## 🔧 CONFIGURAR O CHAT FRONTEND

No arquivo `chat-widget-FINAL.html`, substitua:

```javascript
// ANTES:
const response = await fetch('https://api.anthropic.com/v1/messages', {

// DEPOIS:
const response = await fetch('https://SEU-PROJETO.vercel.app/api/chat', {
```

E **REMOVA** estas linhas:
```javascript
// REMOVER:
'x-api-key': ANTHROPIC_API_KEY,
'anthropic-version': '2023-06-01'
```

O código correto fica:
```javascript
const response = await fetch('https://SEU-PROJETO.vercel.app/api/chat', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        messages: conversationHistory
    })
});
```

---

## 📊 MONITORAMENTO

### **Ver Logs:**
1. Dashboard Vercel
2. Projeto → **Functions**
3. Clique em `/api/chat`
4. Veja logs em tempo real

### **Limites Vercel (Free Tier):**
- ✅ 100GB bandwidth/mês
- ✅ 100 horas serverless/mês
- ✅ Suficiente para ~10.000 mensagens/mês

---

## 🔒 SEGURANÇA

✅ **API Key nunca exposta** no frontend
✅ **CORS configurado** (aceita qualquer origem)
✅ **Rate limiting** via Vercel (automático)
✅ **Logs** para debug

⚠️ **Para produção séria:**
- Configure CORS só para seu domínio
- Adicione autenticação
- Configure rate limiting customizado

---

## 🆘 TROUBLESHOOTING

### **Erro 500: Server configuration error**
- API Key não foi adicionada nas env vars
- Solução: Adicione `ANTHROPIC_API_KEY` e redeploy

### **Erro CORS ainda aparece**
- Cache do navegador
- Solução: Hard refresh (`Cmd + Shift + R`)

### **Erro 400: Invalid request**
- Frontend não está enviando `messages` correto
- Verifique estrutura do JSON

---

## 💰 CUSTOS

### **Vercel:** Grátis (até 100GB/mês)
### **Anthropic:** ~$0.003 por mensagem
### **Total:** ~$3/mês para 1000 mensagens

---

## 📁 ESTRUTURA

```
dexan-chat-backend/
├── api/
│   └── chat.js          # Endpoint principal
├── package.json         # Config npm
├── vercel.json         # Config Vercel
├── .gitignore          # Ignora node_modules
└── README.md           # Este arquivo
```

---

## ✅ CHECKLIST

- [ ] Criar repo GitHub
- [ ] Push código
- [ ] Conectar na Vercel
- [ ] Deploy
- [ ] Adicionar ANTHROPIC_API_KEY
- [ ] Redeploy
- [ ] Testar endpoint
- [ ] Atualizar frontend
- [ ] Testar chat completo

---

**Pronto! Backend configurado com sucesso!** 🎉
