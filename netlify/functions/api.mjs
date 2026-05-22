import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { getStore } from "@netlify/blobs";

const ROOT = process.cwd();
const IS_NETLIFY = Boolean(process.env.NETLIFY || process.env.CONTEXT || process.env.URL);
loadEnv();

const PORT = Number(process.env.PORT || 5173);
const DATA_DIR = join(ROOT, "data");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");
const ORDERS_FILE = join(DATA_DIR, "orders.json");
const LOGS_FILE = join(DATA_DIR, "logs.json");
const BACKUPS_DIR = join(ROOT, "backups");
const PRODUCTS_JS_FILE = join(ROOT, "assets", "js", "products.js");
const UPLOADS_DIR = join(ROOT, "uploads");
const SESSION_COOKIE = "fluxo_session";
const OAUTH_STATE_COOKIE = "fluxo_oauth_state";
const deliveryLocks = new Map();

// Em Netlify, os dados persistem via Netlify Blobs. Localmente, o server.js antigo ainda pode usar arquivos JSON.

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".gif": "image/gif"
};

const DISCORD_PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n
};

const CHANNEL_ALLOW = String(
  DISCORD_PERMISSIONS.VIEW_CHANNEL |
  DISCORD_PERMISSIONS.SEND_MESSAGES |
  DISCORD_PERMISSIONS.EMBED_LINKS |
  DISCORD_PERMISSIONS.ATTACH_FILES |
  DISCORD_PERMISSIONS.READ_MESSAGE_HISTORY
);
const CHANNEL_DENY_VIEW = String(DISCORD_PERMISSIONS.VIEW_CHANNEL);

function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const content = Buffer.from(readFileSync(envPath)).toString("utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=").trim().replace(/^[\"']|[\"']$/g, "");
    if (!process.env[key.trim()]) process.env[key.trim()] = value;
  }
}

async function ensureDataFiles() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOADS_DIR, { recursive: true });
  await mkdir(BACKUPS_DIR, { recursive: true });
  if (!existsSync(PRODUCTS_FILE)) await writeJson(PRODUCTS_FILE, []);
  if (!existsSync(ORDERS_FILE)) await writeJson(ORDERS_FILE, []);
  if (!existsSync(LOGS_FILE)) await writeJson(LOGS_FILE, []);
  await syncProductsJs();
}

function originFromRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function text(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (!key) continue;
    cookies[key] = decodeURIComponent(value.join("="));
  }
  return cookies;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true") parts.push("Secure");
  return parts.join("; ");
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Configure SESSION_SECRET no .env com pelo menos 32 caracteres.");
  return secret;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(value) {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

function createSessionCookie(user) {
  const payload = b64url(JSON.stringify({
    id: user.id,
    username: user.username,
    avatar: user.avatar || null,
    isAdmin: true,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  }));
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  try {
    const value = parseCookies(req)[SESSION_COOKIE];
    if (!value || !value.includes(".")) return null;
    const [payload, sig] = value.split(".");
    const expected = sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || Date.now() > data.exp) return null;
    if (!data.id || !data.isAdmin) return null;
    return { id: data.id, username: data.username || "Admin", avatar: data.avatar || null, isAdmin: true };
  } catch {
    return null;
  }
}

function requireAdmin(req, res) {
  const session = readSession(req);
  if (!session) {
    json(res, 401, { error: "Não autenticado" });
    return null;
  }
  if (!session.isAdmin) {
    json(res, 403, { error: "Acesso negado" });
    return null;
  }
  return session;
}

function splitEnv(value = "") {
  return value.split(/[ ,;]+/).map((v) => v.trim()).filter(Boolean);
}

function discordConfig({ adminRequired = false } = {}) {
  const clientId = process.env.DISCORD_CLIENT_ID || "";
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || "";
  if (adminRequired && (!clientId || !clientSecret)) {
    throw new Error("Configure DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET no .env.");
  }
  return {
    clientId,
    clientSecret,
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    adminRoleId: process.env.DISCORD_ADMIN_ROLE_ID || "",
    adminUserIds: splitEnv(process.env.DISCORD_ADMIN_USER_IDS),
    deliveryCategoryId: process.env.DISCORD_DELIVERY_CATEGORY_ID || "",
    deliveryStaffRoleId: process.env.DISCORD_DELIVERY_STAFF_ROLE_ID || ""
  };
}

function redirectUri(origin) {
  return process.env.DISCORD_REDIRECT_URI || `${origin}/api/auth/discord/callback`;
}

async function exchangeCodeForToken(code, redirect_uri) {
  const { clientId, clientSecret } = discordConfig({ adminRequired: true });
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri });
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Falha no token do Discord: ${response.status} ${await response.text()}`);
  return response.json();
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Falha ao buscar usuário Discord: ${response.status}`);
  return response.json();
}

async function fetchGuildMember(userId) {
  const { botToken, guildId } = discordConfig();
  if (!botToken || !guildId) return null;
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, { headers: { Authorization: `Bot ${botToken}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Falha ao buscar membro da guilda: ${response.status} ${await response.text()}`);
  return response.json();
}

async function isDiscordAdmin(userId) {
  const { adminUserIds, adminRoleId, botToken, guildId } = discordConfig();
  if (adminUserIds.includes(userId)) return { ok: true };
  if (!botToken || !guildId || !adminRoleId) return { ok: false, reason: "missing_role_config" };
  const member = await fetchGuildMember(userId);
  if (!member) return { ok: false, reason: "not_in_server" };
  if (!Array.isArray(member.roles) || !member.roles.includes(adminRoleId)) return { ok: false, reason: "not_admin" };
  return { ok: true };
}

function dataStore() {
  return getStore("fluxostore-data");
}

function uploadsStore() {
  return getStore("fluxostore-uploads");
}

async function readSeedJson(_key, fallback = []) {
  // No Netlify, evitar depender de caminho físico da function.
  // Os dados reais ficam no Netlify Blobs; se ainda não existir nada salvo, usamos o fallback.
  return fallback;
}

async function readJsonFile(path, fallback = []) {
  const key = basename(path);
  if (IS_NETLIFY) {
    try {
      const raw = await dataStore().get(key, { type: "text" });
      if (!raw) return readSeedJson(key, fallback);
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : fallback;
    } catch {
      return readSeedJson(key, fallback);
    }
  }

  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(path, data) {
  const key = basename(path);
  if (IS_NETLIFY) {
    await dataStore().set(key, JSON.stringify(data, null, 2));
    return;
  }
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

async function readProducts() {
  await ensureDataFilesOnce();
  return readJsonFile(PRODUCTS_FILE, []);
}

async function writeProducts(products) {
  await writeJson(PRODUCTS_FILE, products);
  await syncProductsJs(products);
}

async function readOrders() {
  await ensureDataFilesOnce();
  return readJsonFile(ORDERS_FILE, []);
}

async function writeOrders(orders) {
  await writeJson(ORDERS_FILE, orders);
}

async function readLogs() {
  await ensureDataFilesOnce();
  return readJsonFile(LOGS_FILE, []);
}

async function writeLogs(logs) {
  await writeJson(LOGS_FILE, logs.slice(0, 500));
}

async function addLog(type, message, data = {}) {
  try {
    const logs = await readLogs();
    logs.unshift({
      id: randomUUID(),
      type,
      message,
      data,
      createdAt: new Date().toISOString()
    });
    await writeLogs(logs);
  } catch (error) {
    console.error("Falha ao salvar log:", error);
  }
}

const ORDER_STATUS = {
  pending_payment: "Aguardando pagamento",
  approved: "Pagamento aprovado",
  delivery_channel_created: "Canal criado",
  delivery_error: "Erro na entrega",
  delivering: "Em entrega",
  delivered: "Entregue",
  canceled: "Cancelado",
  refunded: "Reembolso"
};

function normalizeOrderStatus(status) {
  const value = String(status || "").trim();
  return Object.prototype.hasOwnProperty.call(ORDER_STATUS, value) ? value : "pending_payment";
}

let ensured = false;
async function ensureDataFilesOnce() {
  if (ensured) return;
  ensured = true;
  if (IS_NETLIFY) return;
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOADS_DIR, { recursive: true });
  await mkdir(BACKUPS_DIR, { recursive: true });
  if (!existsSync(PRODUCTS_FILE)) await writeJson(PRODUCTS_FILE, []);
  if (!existsSync(ORDERS_FILE)) await writeJson(ORDERS_FILE, []);
  if (!existsSync(LOGS_FILE)) await writeJson(LOGS_FILE, []);
}

function publicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    category: product.category || "Fish World BR",
    price: Number(product.price || 0),
    available: !!product.available,
    image: product.image || "",
    shortDescription: product.shortDescription || "",
    fullDescription: product.fullDescription || ""
  };
}

async function syncProductsJs(products = null) {
  if (IS_NETLIFY) return;
  const all = products || (existsSync(PRODUCTS_FILE) ? JSON.parse(await readFile(PRODUCTS_FILE, "utf8")) : []);
  const publicProducts = all.filter((p) => p.active !== false).map(publicProduct);
  const content = `// Arquivo gerado automaticamente pelo painel admin.\n// Edite produtos pelo /admin, não manualmente.\nwindow.FLUXO_PRODUCTS = ${JSON.stringify(publicProducts, null, 2)};\n`;
  await writeFile(PRODUCTS_JS_FILE, content, "utf8");
}

function normalizeProduct(input, previous = {}) {
  const now = new Date().toISOString();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Nome do produto é obrigatório.");
  const price = Number(String(input.price || 0).replace(",", "."));
  if (!Number.isFinite(price) || price < 0) throw new Error("Preço inválido.");
  return {
    id: previous.id || input.id || randomUUID(),
    name,
    category: String(input.category || "Fish World BR").trim(),
    price,
    available: Boolean(input.available),
    active: input.active !== false,
    image: String(input.image || "").trim(),
    shortDescription: String(input.shortDescription || "").trim().slice(0, 280),
    fullDescription: String(input.fullDescription || "").trim().slice(0, 5000),
    createdAt: previous.createdAt || now,
    updatedAt: now
  };
}

async function readRequestBody(req, limitBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("Requisição muito grande.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseJsonBody(req) {
  const buffer = await readRequestBody(req, 1024 * 1024);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString("utf8"));
}

function parseMultipartUpload(buffer, contentType) {
  const match = /boundary=(?:(?:\")([^\"]+)(?:\")|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("Upload inválido.");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start, headerEnd).toString("utf8");
    let next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    let contentEnd = next;
    if (buffer[contentEnd - 2] === 13 && buffer[contentEnd - 1] === 10) contentEnd -= 2;
    const content = buffer.slice(headerEnd + 4, contentEnd);
    const disposition = /content-disposition:.*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || "application/octet-stream";
    if (disposition?.[1] === "file" && disposition?.[2]) return { filename: basename(disposition[2]), type, content };
    start = next;
  }
  throw new Error("Arquivo não encontrado no upload.");
}

function extFromUpload(filename, type) {
  const byName = extname(filename || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(byName)) return byName;
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  return ".jpg";
}

function cleanCustomer(input = {}) {
  const email = String(input.email || "").trim().toLowerCase();
  const discordId = String(input.discordId || "").trim();
  const name = String(input.name || "Cliente").trim().slice(0, 80) || "Cliente";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Informe um e-mail válido.");
  if (!/^\d{15,25}$/.test(discordId)) throw new Error("Informe o ID numérico do Discord do cliente.");
  return { email, discordId, name };
}

function orderCode() {
  return `FS-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

async function buildOrderItems(cart = []) {
  if (!Array.isArray(cart) || !cart.length) throw new Error("Carrinho vazio.");
  const products = (await readProducts()).filter((p) => p.active !== false && p.available);
  const items = [];
  for (const entry of cart) {
    const id = String(entry.id || "");
    const quantity = Math.max(1, Math.min(99, Number.parseInt(entry.quantity || entry.qty || 1, 10) || 1));
    const product = products.find((p) => String(p.id) === id);
    if (!product) throw new Error("Um dos produtos do carrinho está indisponível.");
    const unitPrice = Number(product.price || 0);
    items.push({ id: product.id, name: product.name, quantity, unitPrice, total: Number((unitPrice * quantity).toFixed(2)) });
  }
  if (!items.length) throw new Error("Carrinho vazio.");
  const total = Number(items.reduce((sum, item) => sum + item.total, 0).toFixed(2));
  if (!Number.isFinite(total) || total <= 0) throw new Error("Total inválido.");
  return { items, total };
}

function publicOrder(order) {
  return {
    id: order.id,
    code: order.code,
    status: order.status,
    total: order.total,
    items: order.items,
    customer: { email: order.customer?.email || "", discordId: order.customer?.discordId || "" },
    payment: order.payment ? {
      id: order.payment.id,
      status: order.payment.status,
      statusDetail: order.payment.statusDetail || "",
      qrCode: order.payment.qrCode,
      qrCodeBase64: order.payment.qrCodeBase64,
      ticketUrl: order.payment.ticketUrl,
      lastCheckedAt: order.payment.lastCheckedAt || null
    } : null,
    delivery: order.delivery || null,
    deliveryError: order.deliveryError || null,
    statusLabel: ORDER_STATUS[order.status] || order.status || "-",
    createdAt: order.createdAt,
    approvedAt: order.approvedAt || null,
    deliveredAt: order.deliveredAt || null,
    canceledAt: order.canceledAt || null,
    refundedAt: order.refundedAt || null
  };
}

function mercadoPagoToken() {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN || "";
  if (!token) throw new Error("Configure MERCADOPAGO_ACCESS_TOKEN no .env.");
  return token;
}

async function createMercadoPagoPix(order, origin) {
  const notificationUrl = process.env.MERCADOPAGO_WEBHOOK_URL || `${origin}/api/webhooks/mercadopago`;
  const body = {
    transaction_amount: Number(order.total.toFixed(2)),
    description: `Fluxo Store - Pedido ${order.code}`,
    payment_method_id: "pix",
    external_reference: order.id,
    notification_url: notificationUrl,
    payer: {
      email: order.customer.email,
      first_name: order.customer.name
    }
  };

  const response = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mercadoPagoToken()}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": order.id
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(async () => ({ message: await response.text() }));
  if (!response.ok) throw new Error(`Mercado Pago recusou o Pix: ${data.message || response.status}`);

  const transaction = data.point_of_interaction?.transaction_data || {};
  return {
    id: String(data.id),
    status: data.status || "pending",
    qrCode: transaction.qr_code || "",
    qrCodeBase64: transaction.qr_code_base64 || "",
    ticketUrl: transaction.ticket_url || ""
  };
}

async function getMercadoPagoPayment(paymentId) {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${mercadoPagoToken()}` }
  });
  const data = await response.json().catch(async () => ({ message: await response.text() }));
  if (!response.ok) throw new Error(`Não consegui consultar pagamento: ${data.message || response.status}`);
  return data;
}

function isPaymentApproved(payment) {
  return payment?.status === "approved" || payment?.status_detail === "accredited";
}

async function fetchBotUser(botToken) {
  const response = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${botToken}` } });
  if (!response.ok) return null;
  return response.json();
}

function cleanChannelName(value) {
  return String(value || "pedido").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "pedido";
}

function deliveryBotConfig() {
  return {
    apiUrl: process.env.DELIVERY_BOT_API_URL || process.env.BOT_DELIVERY_API_URL || "",
    apiSecret: process.env.DELIVERY_BOT_API_SECRET || process.env.BOT_API_SECRET || ""
  };
}

async function createDeliveryViaBotApi(order) {
  const { apiUrl, apiSecret } = deliveryBotConfig();
  if (!apiUrl) return null;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiSecret ? { "x-bot-secret": apiSecret } : {})
    },
    body: JSON.stringify({ order })
  });

  const data = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) throw new Error(data.error || "O bot não criou o canal de entrega.");

  const delivery = data.delivery || data;
  return {
    channelId: delivery.channelId,
    channelName: delivery.channelName,
    channelUrl: delivery.channelUrl,
    createdAt: delivery.createdAt || new Date().toISOString(),
    alreadyExists: Boolean(delivery.alreadyExists),
    source: "bot_api"
  };
}

async function findExistingDiscordChannelForOrder(order, botToken, guildId) {
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` }
  });
  if (!response.ok) return null;

  const channels = await response.json().catch(() => []);
  if (!Array.isArray(channels)) return null;

  const cleanCode = cleanChannelName(order.code);
  const customerSuffix = order.customer.discordId.slice(-4);
  const found = channels.find((channel) => {
    const topic = String(channel.topic || "");
    const name = String(channel.name || "");
    const sameCode = topic.includes(order.code) || name.includes(cleanCode);
    const sameCustomer = topic.includes(order.customer.discordId) || name.endsWith(customerSuffix);
    return channel.type === 0 && sameCode && sameCustomer;
  });

  if (!found) return null;
  return {
    channelId: found.id,
    channelName: found.name,
    channelUrl: `https://discord.com/channels/${guildId}/${found.id}`,
    createdAt: new Date().toISOString(),
    alreadyExists: true,
    source: "discord_scan"
  };
}

async function createDeliveryChannelForOrderLocked(order) {
  if (order.delivery?.channelId) return order.delivery;

  const botDelivery = await createDeliveryViaBotApi(order);
  if (botDelivery?.channelId) return botDelivery;

  const { botToken, guildId, deliveryCategoryId, deliveryStaffRoleId } = discordConfig();
  if (!botToken || !guildId) throw new Error("Configure DELIVERY_BOT_API_URL para usar o bot separado, ou DISCORD_BOT_TOKEN e DISCORD_GUILD_ID para criar canais direto pelo site.");

  const alreadyCreated = await findExistingDiscordChannelForOrder(order, botToken, guildId);
  if (alreadyCreated?.channelId) return alreadyCreated;

  const botUser = await fetchBotUser(botToken);
  const overwrites = [
    { id: guildId, type: 0, deny: CHANNEL_DENY_VIEW },
    { id: order.customer.discordId, type: 1, allow: CHANNEL_ALLOW }
  ];
  if (deliveryStaffRoleId) overwrites.push({ id: deliveryStaffRoleId, type: 0, allow: CHANNEL_ALLOW });
  if (botUser?.id) overwrites.push({ id: botUser.id, type: 1, allow: CHANNEL_ALLOW });

  const body = {
    name: cleanChannelName(`entrega-${order.code}-${order.customer.discordId.slice(-4)}`),
    type: 0,
    topic: `Entrega Fluxo Store | Pedido ${order.code} | Cliente ${order.customer.discordId}`,
    permission_overwrites: overwrites
  };
  if (deliveryCategoryId) body.parent_id = deliveryCategoryId;

  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const channel = await response.json().catch(async () => ({ message: await response.text() }));
  if (!response.ok) throw new Error(`Discord não criou o canal: ${channel.message || response.status}`);

  const lines = [
    `🛒 **Novo pedido aprovado — ${order.code}**`,
    `Cliente: <@${order.customer.discordId}>`,
    `E-mail: ${order.customer.email}`,
    `Total: R$ ${order.total.toFixed(2).replace(".", ",")}`,
    "",
    "**Itens:**",
    ...order.items.map((item) => `• ${item.quantity}x ${item.name} — R$ ${item.total.toFixed(2).replace(".", ",")}`),
    "",
    "A equipe da Fluxo Store vai seguir com a entrega por este canal."
  ];

  await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: lines.join("\n") })
  }).catch(() => null);

  return {
    channelId: channel.id,
    channelName: channel.name,
    channelUrl: `https://discord.com/channels/${guildId}/${channel.id}`,
    createdAt: new Date().toISOString(),
    source: "site_direct"
  };
}

async function createDeliveryChannelForOrder(order) {
  if (order.delivery?.channelId) return order.delivery;

  const lockKey = order.code || order.id;
  if (deliveryLocks.has(lockKey)) return deliveryLocks.get(lockKey);

  const promise = createDeliveryChannelForOrderLocked(order)
    .finally(() => deliveryLocks.delete(lockKey));
  deliveryLocks.set(lockKey, promise);
  return promise;
}

async function refreshOrderPayment(order) {
  if (!order?.payment?.id) return order;
  const payment = await getMercadoPagoPayment(order.payment.id);

  if (payment.external_reference && String(payment.external_reference) !== String(order.id)) {
    throw new Error("Pagamento retornado não pertence a este pedido.");
  }

  order.payment.status = payment.status || order.payment.status;
  order.payment.statusDetail = payment.status_detail || "";
  order.payment.lastCheckedAt = new Date().toISOString();

  if (["cancelled", "canceled"].includes(payment.status)) {
    order.status = "canceled";
    order.canceledAt = order.canceledAt || new Date().toISOString();
    await addLog("payment_canceled", `Pagamento cancelado no pedido ${order.code}.`, { orderId: order.id, code: order.code, paymentId: order.payment.id });
    return order;
  }

  if (["refunded", "charged_back"].includes(payment.status)) {
    order.status = "refunded";
    order.refundedAt = order.refundedAt || new Date().toISOString();
    await addLog("payment_refunded", `Pagamento reembolsado no pedido ${order.code}.`, { orderId: order.id, code: order.code, paymentId: order.payment.id });
    return order;
  }

  if (isPaymentApproved(payment)) {
    const firstApproval = !order.approvedAt;
    order.status = order.delivery?.channelId ? "delivery_channel_created" : "approved";
    order.approvedAt = order.approvedAt || new Date().toISOString();

    if (firstApproval) {
      await addLog("payment_approved", `Pagamento aprovado no pedido ${order.code}.`, { orderId: order.id, code: order.code, paymentId: order.payment.id, total: order.total });
    }

    if (!order.delivery?.channelId) {
      try {
        order.delivery = await createDeliveryChannelForOrder(order);
        order.status = "delivery_channel_created";
        delete order.deliveryError;
        await addLog("delivery_channel_created", `Canal de entrega criado para o pedido ${order.code}.`, { orderId: order.id, code: order.code, channelUrl: order.delivery?.channelUrl });
      } catch (error) {
        order.status = "delivery_error";
        order.deliveryError = error.message;
        await addLog("delivery_error", `Erro ao criar canal para o pedido ${order.code}: ${error.message}`, { orderId: order.id, code: order.code });
      }
    }
  }
  return order;
}

async function findAndRefreshOrder(orderId) {
  const orders = await readOrders();
  const index = orders.findIndex((order) => order.id === orderId || order.code === orderId);
  if (index === -1) throw new Error("Pedido não encontrado.");
  const order = await refreshOrderPayment(orders[index]);
  orders[index] = order;
  await writeOrders(orders);
  return order;
}

async function handleMercadoPagoWebhook(req, res, url) {
  let body = {};
  if (req.method !== "GET") {
    try { body = await parseJsonBody(req); } catch { body = {}; }
  }
  const paymentId = url.searchParams.get("data.id") || url.searchParams.get("id") || body?.data?.id || body?.id;
  if (!paymentId) return json(res, 200, { ok: true, ignored: true });

  const orders = await readOrders();
  const index = orders.findIndex((order) => String(order.payment?.id) === String(paymentId));
  if (index === -1) return json(res, 200, { ok: true, ignored: true });
  try {
    orders[index] = await refreshOrderPayment(orders[index]);
    await writeOrders(orders);
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error("Mercado Pago webhook error:", error);
    return json(res, 200, { ok: true, error: error.message });
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { discordInvite: "https://discord.gg/u5sW9gJU4R" });
  }

  if (req.method === "GET" && /^\/api\/uploads\/[^/]+$/.test(url.pathname)) {
    const name = basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
    if (!name) return text(res, 404, "Arquivo não encontrado.");
    if (IS_NETLIFY) {
      const arrayBuffer = await uploadsStore().get(name, { type: "arrayBuffer" });
      if (!arrayBuffer) return text(res, 404, "Arquivo não encontrado.");
      const ext = extname(name).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" });
      return res.end(Buffer.from(arrayBuffer));
    }
    const filePath = join(UPLOADS_DIR, name);
    if (!existsSync(filePath)) return text(res, 404, "Arquivo não encontrado.");
    const ext = extname(name).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" });
    return res.end(await readFile(filePath));
  }


  if (req.method === "GET" && url.pathname === "/api/auth/me") return json(res, 200, { user: readSession(req) });
  if (req.method === "GET" && url.pathname === "/api/auth/logout") return redirect(res, "/", { "Set-Cookie": cookie(SESSION_COOKIE, "", { maxAge: 0 }) });

  if (req.method === "GET" && url.pathname === "/api/auth/discord/login") {
    try {
      const { clientId } = discordConfig({ adminRequired: true });
      const state = randomBytes(24).toString("base64url");
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(originFromRequest(req)), response_type: "code", scope: "identify", prompt: "consent", state });
      return redirect(res, `https://discord.com/api/oauth2/authorize?${params}`, { "Set-Cookie": cookie(OAUTH_STATE_COOKIE, state, { maxAge: 60 * 5 }) });
    } catch (error) {
      return redirect(res, `/auth.html?error=${encodeURIComponent(error.message)}`);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/auth/discord/callback") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const savedState = parseCookies(req)[OAUTH_STATE_COOKIE];
    const clearState = cookie(OAUTH_STATE_COOKIE, "", { maxAge: 0 });
    if (error) return redirect(res, `/auth.html?error=${encodeURIComponent(error)}`, { "Set-Cookie": clearState });
    if (!code) return redirect(res, "/auth.html?error=missing_code", { "Set-Cookie": clearState });
    if (!state || !savedState || state !== savedState) return redirect(res, "/auth.html?error=invalid_state", { "Set-Cookie": clearState });
    try {
      const token = await exchangeCodeForToken(code, redirectUri(originFromRequest(req)));
      const user = await fetchDiscordUser(token.access_token);
      const check = await isDiscordAdmin(user.id);
      if (!check.ok) {
        const reason = check.reason === "missing_role_config" ? "not_configured" : check.reason;
        return redirect(res, `/auth.html?error=${reason}`, { "Set-Cookie": clearState });
      }
      const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null;
      const sessionCookie = createSessionCookie({ id: user.id, username: user.global_name || user.username, avatar });
      return redirect(res, "/admin.html", { "Set-Cookie": [clearState, cookie(SESSION_COOKIE, sessionCookie, { maxAge: 60 * 60 * 24 * 7 })] });
    } catch (error) {
      console.error("Discord OAuth error:", error);
      return redirect(res, "/auth.html?error=oauth_failed", { "Set-Cookie": clearState });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/products") {
    const products = (await readProducts()).filter((p) => p.active !== false).map(publicProduct);
    return json(res, 200, { products });
  }

  if (req.method === "POST" && url.pathname === "/api/checkout/pix") {
    try {
      const input = await parseJsonBody(req);
      const customer = cleanCustomer(input.customer || {});
      const { items, total } = await buildOrderItems(input.cart || []);
      const order = { id: randomUUID(), code: orderCode(), status: "pending_payment", customer, items, total, createdAt: new Date().toISOString() };
      order.payment = await createMercadoPagoPix(order, originFromRequest(req));
      const orders = await readOrders();
      orders.unshift(order);
      await writeOrders(orders);
      await addLog("order_created", `Pedido ${order.code} criado e aguardando pagamento.`, { orderId: order.id, code: order.code, total: order.total, email: order.customer.email });
      return json(res, 200, { order: publicOrder(order) });
    } catch (error) {
      return json(res, 400, { error: error.message || "Não foi possível gerar o Pix." });
    }
  }

  const orderMatch = /^\/api\/orders\/([^/]+)$/.exec(url.pathname);
  if (orderMatch && req.method === "GET") {
    const orders = await readOrders();
    const order = orders.find((item) => item.id === decodeURIComponent(orderMatch[1]) || item.code === decodeURIComponent(orderMatch[1]));
    if (!order) return json(res, 404, { error: "Pedido não encontrado." });
    return json(res, 200, { order: publicOrder(order) });
  }

  const checkMatch = /^\/api\/orders\/([^/]+)\/check$/.exec(url.pathname);
  if (checkMatch && req.method === "POST") {
    try {
      const order = await findAndRefreshOrder(decodeURIComponent(checkMatch[1]));
      return json(res, 200, { order: publicOrder(order) });
    } catch (error) {
      return json(res, 400, { error: error.message || "Não foi possível consultar o pagamento." });
    }
  }

  if (url.pathname === "/api/webhooks/mercadopago") return handleMercadoPagoWebhook(req, res, url);

  if (url.pathname === "/api/admin/products" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const products = await readProducts();
    return json(res, 200, { products: products.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
  }

  if (url.pathname === "/api/admin/orders" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const orders = await readOrders();
    return json(res, 200, { orders: orders.map(publicOrder), statuses: ORDER_STATUS });
  }

  if (url.pathname === "/api/admin/logs" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const logs = await readLogs();
    return json(res, 200, { logs: logs.slice(0, 200) });
  }

  if (url.pathname === "/api/admin/backup" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const products = await readProducts();
    const orders = await readOrders();
    const logs = await readLogs();
    return json(res, 200, { exportedAt: new Date().toISOString(), products, orders, logs });
  }

  const adminOrderMatch = /^\/api\/admin\/orders\/([^/]+)\/(refresh|retry-delivery|status)$/.exec(url.pathname);
  if (adminOrderMatch && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    const orderId = decodeURIComponent(adminOrderMatch[1]);
    const action = adminOrderMatch[2];
    try {
      const orders = await readOrders();
      const index = orders.findIndex((order) => order.id === orderId || order.code === orderId);
      if (index === -1) return json(res, 404, { error: "Pedido não encontrado." });

      if (action === "refresh") {
        orders[index] = await refreshOrderPayment(orders[index]);
        await writeOrders(orders);
        return json(res, 200, { order: publicOrder(orders[index]) });
      }

      if (action === "retry-delivery") {
        if (!orders[index].approvedAt && !["approved", "delivery_error"].includes(orders[index].status)) {
          return json(res, 400, { error: "Só é possível recriar canal de pedido pago/aprovado." });
        }
        delete orders[index].deliveryError;
        orders[index].delivery = await createDeliveryChannelForOrder(orders[index]);
        orders[index].status = "delivery_channel_created";
        await writeOrders(orders);
        await addLog("delivery_retry", `Canal de entrega recriado/verificado no pedido ${orders[index].code}.`, { orderId: orders[index].id, code: orders[index].code, channelUrl: orders[index].delivery?.channelUrl });
        return json(res, 200, { order: publicOrder(orders[index]) });
      }

      if (action === "status") {
        const input = await parseJsonBody(req);
        const status = normalizeOrderStatus(input.status);
        orders[index].status = status;
        if (status === "delivering") orders[index].deliveringAt = orders[index].deliveringAt || new Date().toISOString();
        if (status === "delivered") orders[index].deliveredAt = orders[index].deliveredAt || new Date().toISOString();
        if (status === "canceled") orders[index].canceledAt = orders[index].canceledAt || new Date().toISOString();
        if (status === "refunded") orders[index].refundedAt = orders[index].refundedAt || new Date().toISOString();
        await writeOrders(orders);
        await addLog("order_status_changed", `Status do pedido ${orders[index].code} alterado para ${ORDER_STATUS[status]}.`, { orderId: orders[index].id, code: orders[index].code, status });
        return json(res, 200, { order: publicOrder(orders[index]) });
      }
    } catch (error) {
      return json(res, 400, { error: error.message || "Erro ao atualizar pedido." });
    }
  }

  if (url.pathname === "/api/admin/products" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    try {
      const input = await parseJsonBody(req);
      const products = await readProducts();
      const index = input.id ? products.findIndex((p) => p.id === input.id) : -1;
      const product = normalizeProduct(input, index >= 0 ? products[index] : {});
      if (index >= 0) products[index] = product;
      else products.unshift(product);
      await writeProducts(products);
      return json(res, 200, { product });
    } catch (error) {
      return json(res, 400, { error: error.message || "Erro ao salvar produto" });
    }
  }

  const productMatch = /^\/api\/admin\/products\/([^/]+)$/.exec(url.pathname);
  if (productMatch && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const products = await readProducts();
    const product = products.find((p) => p.id === decodeURIComponent(productMatch[1]));
    if (!product) return json(res, 404, { error: "Produto não encontrado" });
    return json(res, 200, { product });
  }

  if (productMatch && req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(productMatch[1]);
    const products = (await readProducts()).filter((p) => p.id !== id);
    await writeProducts(products);
    return json(res, 200, { ok: true });
  }

  const toggleMatch = /^\/api\/admin\/products\/([^/]+)\/toggle$/.exec(url.pathname);
  if (toggleMatch && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(toggleMatch[1]);
    const products = await readProducts();
    const product = products.find((p) => p.id === id);
    if (!product) return json(res, 404, { error: "Produto não encontrado" });
    product.available = !product.available;
    product.updatedAt = new Date().toISOString();
    await writeProducts(products);
    return json(res, 200, { product });
  }

  if (url.pathname === "/api/admin/upload" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    try {
      const buffer = await readRequestBody(req, 5 * 1024 * 1024 + 1024 * 64);
      const file = parseMultipartUpload(buffer, req.headers["content-type"] || "");
      if (!String(file.type).startsWith("image/")) throw new Error("Envie apenas imagem.");
      if (file.content.length > 5 * 1024 * 1024) throw new Error("Imagem maior que 5MB.");
      const name = `${randomUUID()}${extFromUpload(file.filename, file.type)}`;
      if (IS_NETLIFY) {
        await uploadsStore().set(name, file.content, { metadata: { contentType: file.type } });
        return json(res, 200, { url: `/api/uploads/${name}` });
      }
      await writeFile(join(UPLOADS_DIR, name), file.content);
      return json(res, 200, { url: `/uploads/${name}` });
    } catch (error) {
      return json(res, 400, { error: error.message || "Erro ao enviar imagem" });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}

function mapPrettyPath(pathname) {
  if (pathname === "/") return "/index.html";
  if (pathname === "/admin") return "/admin.html";
  if (pathname === "/auth") return "/auth.html";
  if (pathname === "/carrinho") return "/carrinho.html";
  if (pathname === "/checkout") return "/checkout.html";
  if (pathname === "/termos") return "/termos.html";
  if (pathname === "/admin-logs") return "/admin-logs.html";
  return pathname;
}

function safePath(urlPath) {
  const mapped = mapPrettyPath(urlPath.split("?")[0]);
  const clean = decodeURIComponent(mapped).replace(/^\/+/, "");
  if (!clean || clean.includes("\0")) return join(ROOT, "index.html");
  if (clean.startsWith("data/") || clean.startsWith("supabase/") || clean.startsWith("node_modules/")) return null;
  if ([".env", "server.js", "package.json", "package-lock.json"].includes(clean)) return null;
  if (clean.startsWith(".")) return null;
  const candidate = normalize(join(ROOT, clean));
  if (!candidate.startsWith(ROOT)) return null;
  return candidate;
}

async function serveStatic(req, res, url) {
  let filePath = safePath(url.pathname);
  if (!filePath) return text(res, 403, "Arquivo bloqueado.");
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, "index.html");
  if (!existsSync(filePath)) filePath = join(ROOT, "index.html");
  const ext = extname(filePath).toLowerCase();
  const content = await readFile(filePath);
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if ([".html", ".js", ".css"].includes(ext)) headers["Cache-Control"] = "no-store";
  res.writeHead(200, headers);
  res.end(content);
}


function normalizeHeaderName(name) {
  return String(name || "").toLowerCase();
}

function eventBodyBuffer(event) {
  if (!event.body) return Buffer.alloc(0);
  return Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
}

function pathFromEvent(event) {
  let pathname = event.rawUrl ? new URL(event.rawUrl).pathname : (event.path || "/");
  const fnPrefix = "/.netlify/functions/api";
  if (pathname.startsWith(fnPrefix)) {
    pathname = "/api" + pathname.slice(fnPrefix.length);
  }
  if (pathname === "/api") pathname = "/api/";
  if (!pathname.startsWith("/api/")) pathname = "/api/" + pathname.replace(/^\/+/, "");
  return pathname;
}

function makeRequest(event) {
  const headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) headers[normalizeHeaderName(key)] = value;
  const query = event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString();
  const path = pathFromEvent(event);
  const url = query ? `${path}?${query}` : path;
  const body = eventBodyBuffer(event);
  return {
    method: event.httpMethod || event.method || "GET",
    headers,
    url,
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body;
    }
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    multiValueHeaders: {},
    body: "",
    isBase64Encoded: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers || {})) {
        if (Array.isArray(value)) this.multiValueHeaders[key] = value;
        else this.headers[key] = String(value);
      }
    },
    end(body = "") {
      if (Buffer.isBuffer(body)) {
        this.body = body.toString("base64");
        this.isBase64Encoded = true;
      } else {
        this.body = String(body ?? "");
      }
    },
    toNetlifyResponse() {
      return {
        statusCode: this.statusCode,
        headers: this.headers,
        multiValueHeaders: Object.keys(this.multiValueHeaders).length ? this.multiValueHeaders : undefined,
        body: this.body,
        isBase64Encoded: this.isBase64Encoded
      };
    }
  };
}

export async function handler(event) {
  const req = makeRequest(event);
  const res = makeResponse();
  try {
    const url = new URL(req.url || "/api/", originFromRequest(req));
    await handleApi(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || "Erro interno" });
  }
  return res.toNetlifyResponse();
}
