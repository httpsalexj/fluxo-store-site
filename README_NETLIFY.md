# Fluxo Store — versão Netlify

Esta versão foi adaptada para rodar no Netlify com domínio grátis `netlify.app`.

## O que mudou

- As páginas estáticas ficam em `public/`.
- As APIs ficam em `netlify/functions/api.mjs`.
- Produtos, pedidos, logs e uploads usam Netlify Blobs.
- O site chama o bot hospedado na Railway quando o pagamento Pix é aprovado.

## Como subir no Netlify

1. Crie um repositório no GitHub e envie esta pasta.
2. No Netlify, clique em **Add new site** > **Import an existing project**.
3. Escolha o repositório.
4. Configuração:
   - Build command: `npm run build`
   - Publish directory: `public`
5. Depois do deploy, copie o domínio grátis, exemplo:
   - `https://fluxostore.netlify.app`

## Variáveis de ambiente no Netlify

Cadastre em **Site configuration > Environment variables**:

```env
SESSION_SECRET=uma_chave_grande_com_mais_de_32_caracteres
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=https://SEU-SITE.netlify.app/api/auth/discord/callback
DISCORD_ADMIN_USER_IDS=SEU_ID_DO_DISCORD
MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_WEBHOOK_URL=https://SEU-SITE.netlify.app/api/webhooks/mercadopago
DELIVERY_BOT_API_URL=https://SEU-BOT.up.railway.app/api/delivery
DELIVERY_BOT_API_SECRET=mesma_chave_do_BOT_API_SECRET_do_bot
COOKIE_SECURE=true
```

## Discord Developer Portal

Na aplicação OAuth usada pelo painel admin, adicione em **OAuth2 > Redirects**:

```txt
https://SEU-SITE.netlify.app/api/auth/discord/callback
```

## Mercado Pago

No Mercado Pago, configure a URL de webhook/notificação como:

```txt
https://SEU-SITE.netlify.app/api/webhooks/mercadopago
```

O botão **Já paguei, verificar** também consulta o Mercado Pago diretamente pela API do site.

## Bot Railway

Depois de subir o bot na Railway, troque no Netlify:

```env
DELIVERY_BOT_API_URL=https://SEU-BOT.up.railway.app/api/delivery
```

O segredo precisa ser igual nos dois projetos:

```env
DELIVERY_BOT_API_SECRET=...
BOT_API_SECRET=...
```
