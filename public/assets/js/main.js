const DISCORD_URL = "https://discord.gg/u5sW9gJU4R";
const CART_KEY = "fluxo_store_cart_v2";
const LAST_ORDER_KEY = "fluxo_store_last_order";

function qs(selector, root = document) { return root.querySelector(selector); }
function qsa(selector, root = document) { return [...root.querySelectorAll(selector)]; }

function moneyBRL(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

function products() { return Array.isArray(window.FLUXO_PRODUCTS) ? window.FLUXO_PRODUCTS : []; }
function productById(id) { return products().find((product) => String(product.id) === String(id)); }

async function loadProductsFromApi() {
  try {
    const response = await fetch("/api/products", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.products)) window.FLUXO_PRODUCTS = data.products;
  } catch {}
}

function loadCart() {
  try {
    const cart = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(cart) ? cart.filter((item) => item?.id).map((item) => ({ id: String(item.id), quantity: Math.max(1, Number(item.quantity || 1)) })) : [];
  } catch { return []; }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartCount();
}

function clearCart() {
  saveCart([]);
}

function addToCart(id, quantity = 1) {
  const product = productById(id);
  if (!product || !product.available) {
    showToast("Produto indisponível no momento.", true);
    return;
  }
  const cart = loadCart();
  const existing = cart.find((item) => item.id === String(id));
  if (existing) existing.quantity = Math.min(99, existing.quantity + quantity);
  else cart.push({ id: String(id), quantity });
  saveCart(cart);
  showToast(`${product.name} foi adicionado ao carrinho.`);
}

function removeFromCart(id) {
  saveCart(loadCart().filter((item) => item.id !== String(id)));
  renderCartPage();
}

function changeQuantity(id, delta) {
  const cart = loadCart();
  const item = cart.find((entry) => entry.id === String(id));
  if (!item) return;
  item.quantity = Math.max(1, Math.min(99, item.quantity + delta));
  saveCart(cart);
  renderCartPage();
}

function detailedCart() {
  return loadCart().map((item) => {
    const product = productById(item.id);
    if (!product) return null;
    return { ...item, product, total: Number(product.price || 0) * item.quantity };
  }).filter(Boolean);
}

function cartTotal(items = detailedCart()) {
  return items.reduce((sum, item) => sum + item.total, 0);
}

function updateCartCount() {
  const total = loadCart().reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  qsa("[data-cart-count]").forEach((el) => { el.textContent = String(total); el.hidden = total <= 0; });
}

function showToast(message, danger = false) {
  let toast = qs("#fluxo-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "fluxo-toast";
    toast.className = "fluxo-toast";
    document.body.append(toast);
  }
  toast.className = `fluxo-toast ${danger ? "danger" : ""}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span><a href="carrinho.html">Ver carrinho</a>`;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function createPlaceholder() {
  const placeholder = document.createElement("div");
  placeholder.className = "product-placeholder";
  placeholder.textContent = "sem imagem";
  return placeholder;
}

function productCard(product) {
  const card = document.createElement("article");
  card.className = "product-card hover-gold-glow";

  const imageWrap = document.createElement("a");
  imageWrap.className = "product-image";
  imageWrap.href = `produto.html?id=${encodeURIComponent(product.id)}`;
  if (product.image) {
    const img = document.createElement("img");
    img.src = product.image;
    img.alt = product.name;
    imageWrap.append(img);
  } else {
    imageWrap.append(createPlaceholder());
  }

  const content = document.createElement("div");
  content.className = "product-content";

  const top = document.createElement("div");
  top.className = "product-top";
  top.innerHTML = `
    <span class="product-category">${escapeHtml(product.category || "Produto")}</span>
    <span class="product-status ${product.available ? "available" : "unavailable"}">${product.available ? "disponível" : "indisponível"}</span>
  `;

  const title = document.createElement("a");
  title.className = "product-title";
  title.href = `produto.html?id=${encodeURIComponent(product.id)}`;
  title.textContent = product.name;

  const desc = document.createElement("p");
  desc.className = "product-desc";
  desc.textContent = product.shortDescription || "";

  const price = document.createElement("div");
  price.className = "product-price";
  price.textContent = moneyBRL(product.price);

  const actions = document.createElement("div");
  actions.className = "product-actions";

  const add = document.createElement("button");
  add.className = product.available ? "btn btn-gold" : "btn btn-outline";
  add.type = "button";
  add.disabled = !product.available;
  add.dataset.addCart = product.id;
  add.textContent = product.available ? "Adicionar ao carrinho" : "Indisponível";

  const details = document.createElement("a");
  details.className = "btn btn-outline";
  details.href = `produto.html?id=${encodeURIComponent(product.id)}`;
  details.textContent = "Ver Detalhes";

  actions.append(add, details);
  content.append(top, title, desc, price, actions);
  card.append(imageWrap, content);
  return card;
}

function renderProducts(targetSelector, limit = null) {
  const target = qs(targetSelector);
  if (!target) return;
  const list = (limit ? products().slice(0, limit) : products()).filter((p) => p.available !== false);
  target.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nenhum produto disponível no momento.";
    target.append(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "product-grid";
  list.forEach((product) => grid.append(productCard(product)));
  target.append(grid);
}

function renderProductDetail() {
  const detailRoot = qs("#product-detail");
  if (!detailRoot) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const product = productById(id);

  if (!product) {
    detailRoot.innerHTML = `<div class="empty-state">Produto não encontrado.<br><br><a class="btn btn-outline" href="produtos.html">Voltar à vitrine</a></div>`;
    return;
  }

  document.title = `${product.name} | Fluxo Store`;
  detailRoot.innerHTML = `
    <div class="product-detail">
      <div class="detail-image">
        ${product.image ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">` : `<div class="product-placeholder">sem imagem</div>`}
      </div>
      <div>
        <div class="detail-category">${escapeHtml(product.category || "Produto")}</div>
        <h1 class="detail-title">${escapeHtml(product.name)}</h1>
        <span class="product-status ${product.available ? "available" : "unavailable"}" style="display:inline-flex;margin-top:14px;">${product.available ? "Disponível" : "Indisponível"}</span>
        <div class="detail-price">${moneyBRL(product.price)}</div>
        <p class="detail-text">${escapeHtml(product.fullDescription || product.shortDescription || "Produto disponível na Fluxo Store.")}</p>
        <div class="detail-actions">
          <button class="btn btn-gold" type="button" ${product.available ? `data-add-cart="${escapeHtml(product.id)}"` : "disabled"}>${product.available ? "Adicionar ao carrinho" : "Indisponível"}</button>
          <a class="btn btn-outline" href="carrinho.html">Ver carrinho</a>
          <a class="btn btn-outline" href="produtos.html">Voltar à vitrine</a>
        </div>
      </div>
    </div>
  `;
}

function renderCartPage() {
  const root = qs("#cart-root");
  if (!root) return;
  const items = detailedCart();
  if (!items.length) {
    root.innerHTML = `
      <div class="empty-state cart-empty">
        Seu carrinho está vazio.<br><br>
        <a class="btn btn-gold" href="produtos.html">Ver produtos</a>
      </div>
    `;
    return;
  }
  root.innerHTML = `
    <div class="cart-layout">
      <div class="card cart-card">
        ${items.map(({ product, quantity, total }) => `
          <article class="cart-item">
            <div class="cart-item-image">${product.image ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">` : "sem imagem"}</div>
            <div class="cart-item-info">
              <strong>${escapeHtml(product.name)}</strong>
              <span>${escapeHtml(product.category || "Produto")}</span>
              <b>${moneyBRL(product.price)}</b>
            </div>
            <div class="quantity-control">
              <button type="button" data-qty-minus="${escapeHtml(product.id)}">−</button>
              <span>${quantity}</span>
              <button type="button" data-qty-plus="${escapeHtml(product.id)}">+</button>
            </div>
            <div class="cart-item-total">${moneyBRL(total)}</div>
            <button class="remove-cart" type="button" data-remove-cart="${escapeHtml(product.id)}">Remover</button>
          </article>
        `).join("")}
      </div>
      <aside class="card cart-summary">
        <span>Resumo do pedido</span>
        <strong>${moneyBRL(cartTotal(items))}</strong>
        <p>Depois de continuar, você vai preencher e-mail e ID do Discord. O Pix será gerado automaticamente pelo Mercado Pago.</p>
        <a class="btn btn-gold" href="checkout.html">Continuar para pagamento</a>
        <a class="btn btn-outline" href="produtos.html">Adicionar mais produtos</a>
      </aside>
    </div>
  `;
}

function checkoutSummaryHtml(items) {
  return `
    <div class="checkout-summary-list">
      ${items.map(({ product, quantity, total }) => `
        <div class="checkout-summary-item">
          <span>${quantity}x ${escapeHtml(product.name)}</span>
          <strong>${moneyBRL(total)}</strong>
        </div>
      `).join("")}
      <div class="checkout-summary-total">
        <span>Total</span>
        <strong>${moneyBRL(cartTotal(items))}</strong>
      </div>
    </div>
  `;
}

function renderCheckoutPage() {
  const root = qs("#checkout-root");
  if (!root) return;
  const items = detailedCart();
  if (!items.length) {
    root.innerHTML = `<div class="empty-state">Seu carrinho está vazio.<br><br><a class="btn btn-gold" href="produtos.html">Ver produtos</a></div>`;
    return;
  }
  root.innerHTML = `
    <div class="checkout-layout">
      <form id="checkout-form" class="card checkout-form">
        <div class="checkout-step-badge">Pagamento via Pix automático</div>
        <h2>Dados para entrega</h2>
        <p>Preencha corretamente. O ID do Discord será usado para o bot criar o canal privado de entrega.</p>
        <label>
          <span>Seu nome ou nick</span>
          <input id="customer-name" maxlength="80" placeholder="Ex: Junior" autocomplete="name">
        </label>
        <label>
          <span>E-mail *</span>
          <input id="customer-email" required type="email" placeholder="seuemail@gmail.com" autocomplete="email">
        </label>
        <label>
          <span>ID numérico do Discord *</span>
          <input id="customer-discord-id" required inputmode="numeric" placeholder="Ex: 123456789012345678">
          <small>O cliente precisa estar no servidor da Fluxo Store para ver o canal criado pelo bot.</small>
        </label>
        <label class="terms-check">
          <input id="accept-terms" required type="checkbox">
          <span>Li e aceito os <a href="termos.html" target="_blank" rel="noreferrer">termos de compra</a>, prazo de entrega e política de reembolso.</span>
        </label>
        <button id="generate-pix-button" class="btn btn-gold" type="submit">Gerar Pix</button>
        <a class="btn btn-outline" href="carrinho.html">Voltar ao carrinho</a>
      </form>
      <aside class="card checkout-summary">
        <h3>Resumo</h3>
        ${checkoutSummaryHtml(items)}
      </aside>
    </div>
    <div id="payment-root"></div>
  `;
  qs("#checkout-form")?.addEventListener("submit", createPixPayment);
}

async function createPixPayment(event) {
  event.preventDefault();
  if (!qs("#accept-terms")?.checked) {
    showToast("Aceite os termos de compra para continuar.", true);
    return;
  }
  const button = qs("#generate-pix-button");
  const paymentRoot = qs("#payment-root");
  button.disabled = true;
  button.textContent = "Gerando Pix...";
  paymentRoot.innerHTML = "";
  try {
    const payload = {
      cart: loadCart(),
      customer: {
        name: qs("#customer-name").value,
        email: qs("#customer-email").value,
        discordId: qs("#customer-discord-id").value
      }
    };
    const response = await fetch("/api/checkout/pix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Erro ao gerar Pix.");
    localStorage.setItem(LAST_ORDER_KEY, data.order.id);
    renderPayment(data.order);
    startOrderPolling(data.order.id);
  } catch (error) {
    paymentRoot.innerHTML = `<div class="payment-error card">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "Gerar Pix";
  }
}

function orderStatusLabel(status) {
  return {
    pending_payment: "Aguardando pagamento",
    approved: "Pagamento aprovado",
    delivery_channel_created: "Canal de entrega criado",
    delivery_error: "Erro ao criar canal de entrega",
    delivering: "Em entrega",
    delivered: "Entregue",
    canceled: "Cancelado",
    refunded: "Reembolso"
  }[status] || status || "Aguardando";
}

function renderPayment(order) {
  const root = qs("#payment-root");
  if (!root || !order) return;
  const payment = order.payment || {};
  const approved = ["delivery_channel_created", "approved", "delivering", "delivered", "delivery_error"].includes(order.status);
  root.innerHTML = `
    <section class="card payment-card" id="payment-card">
      <div class="payment-header">
        <div>
          <span class="checkout-step-badge">Pedido ${escapeHtml(order.code)}</span>
          <h2>${approved ? "Pagamento confirmado" : "Pix gerado"}</h2>
          <p>Status: <strong>${escapeHtml(orderStatusLabel(order.status))}</strong></p>
        </div>
        <div class="payment-total">${moneyBRL(order.total)}</div>
      </div>
      ${approved ? renderApproved(order) : renderPix(payment)}
    </section>
  `;
}

function renderPix(payment) {
  return `
    <div class="pix-grid">
      <div class="qr-box">
        ${payment.qrCodeBase64 ? `<img src="data:image/png;base64,${payment.qrCodeBase64}" alt="QR Code Pix">` : `<div class="product-placeholder">QR Code indisponível</div>`}
      </div>
      <div class="pix-copy-box">
        <h3>Pix copia e cola</h3>
        <textarea id="pix-code" readonly rows="6">${escapeHtml(payment.qrCode || "")}</textarea>
        <div class="pix-actions">
          <button class="btn btn-gold" type="button" data-copy-pix>Copiar código Pix</button>
          <button class="btn btn-outline" type="button" data-check-payment>Já paguei, verificar</button>
        </div>
        <p class="text-muted">Após o Mercado Pago confirmar, o bot cria automaticamente um canal privado no Discord para entrega.</p>
      </div>
    </div>
    <div id="payment-status" class="payment-status">Aguardando pagamento...</div>
  `;
}

function renderApproved(order) {
  return `
    <div class="approved-box">
      <div class="approved-icon">✓</div>
      <div>
        <h3>Pagamento aprovado!</h3>
        ${order.delivery?.channelUrl ? `<p>O canal privado de entrega já foi criado no Discord.</p><a class="btn btn-gold" href="${escapeHtml(order.delivery.channelUrl)}" target="_blank" rel="noreferrer">Abrir canal ${escapeHtml(order.delivery.channelName || "")}</a>` : `<p>Pagamento aprovado. O canal será criado automaticamente assim que o bot conseguir acessar o servidor.</p>`}
        ${order.deliveryError ? `<p class="danger-text">Erro do bot: ${escapeHtml(order.deliveryError)}</p>` : ""}
        <a class="btn btn-outline" href="${DISCORD_URL}" target="_blank" rel="noreferrer">Entrar no Discord</a>
      </div>
    </div>
  `;
}

async function checkPayment(orderId, manual = false) {
  const status = qs("#payment-status");
  if (manual && status) status.textContent = "Consultando pagamento...";
  const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/check`, { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Não foi possível verificar.");
  renderPayment(data.order);
  if (data.order.status === "delivery_channel_created" || data.order.status === "approved") {
    clearCart();
    return true;
  }
  const updatedStatus = qs("#payment-status");
  if (updatedStatus) updatedStatus.textContent = "Ainda aguardando a confirmação do Mercado Pago...";
  return false;
}

function startOrderPolling(orderId) {
  clearInterval(startOrderPolling.timer);
  startOrderPolling.timer = setInterval(async () => {
    try {
      const done = await checkPayment(orderId);
      if (done) clearInterval(startOrderPolling.timer);
    } catch {}
  }, 6000);
}

function setFooterYear() {
  qsa("[data-year]").forEach((el) => { el.textContent = new Date().getFullYear(); });
}

function setupMenu() {
  const button = qs("#menu-toggle");
  const menu = qs("#mobile-menu");
  if (!button || !menu) return;
  button.addEventListener("click", () => {
    const open = menu.classList.toggle("open");
    button.textContent = open ? "×" : "☰";
    button.setAttribute("aria-expanded", String(open));
  });
  qsa("a", menu).forEach((link) => link.addEventListener("click", () => {
    menu.classList.remove("open");
    button.textContent = "☰";
    button.setAttribute("aria-expanded", "false");
  }));
}

function setupLinks() {
  qsa("[data-discord]").forEach((link) => link.setAttribute("href", DISCORD_URL));
}

function setupClicks() {
  document.addEventListener("click", async (event) => {
    const add = event.target.closest("[data-add-cart]");
    if (add) addToCart(add.dataset.addCart);

    const remove = event.target.closest("[data-remove-cart]");
    if (remove) removeFromCart(remove.dataset.removeCart);

    const plus = event.target.closest("[data-qty-plus]");
    if (plus) changeQuantity(plus.dataset.qtyPlus, 1);

    const minus = event.target.closest("[data-qty-minus]");
    if (minus) changeQuantity(minus.dataset.qtyMinus, -1);

    const copy = event.target.closest("[data-copy-pix]");
    if (copy) {
      const code = qs("#pix-code")?.value || "";
      await navigator.clipboard.writeText(code).catch(() => null);
      showToast("Código Pix copiado.");
    }

    const check = event.target.closest("[data-check-payment]");
    if (check) {
      const orderId = localStorage.getItem(LAST_ORDER_KEY);
      if (!orderId) return;
      check.disabled = true;
      try {
        const done = await checkPayment(orderId, true);
        if (done) clearInterval(startOrderPolling.timer);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        check.disabled = false;
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadProductsFromApi();
  setupLinks();
  setupMenu();
  setupClicks();
  setFooterYear();
  updateCartCount();
  renderProducts("#home-products", 8);
  renderProducts("#all-products");
  renderProductDetail();
  renderCartPage();
  renderCheckoutPage();
});
