const ERROR_MESSAGES = {
  not_in_server: "Você precisa estar no servidor Discord configurado para acessar o painel.",
  not_admin: "Sua conta Discord não tem o cargo de administrador necessário.",
  not_configured: "O login Discord ainda não foi configurado no arquivo .env.",
  missing_code: "Falha na autenticação. Tente novamente.",
  invalid_state: "Sessão de login expirada. Tente entrar novamente.",
  oauth_failed: "Não foi possível autenticar com o Discord. Confira o .env e a Redirect URI.",
  access_denied: "Login cancelado no Discord."
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function moneyBRL(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Erro na requisição");
  return data;
}

async function getMe() {
  const data = await api("/api/auth/me");
  return data.user || null;
}

async function requireAdminPage() {
  const user = await getMe();
  if (!user || !user.isAdmin) {
    window.location.href = "/auth.html";
    return null;
  }
  return user;
}

function setUser(user) {
  const name = $("#admin-user-name");
  const avatar = $("#admin-user-avatar");
  if (name) name.textContent = user.username || "Admin";
  if (avatar) {
    if (user.avatar) {
      avatar.innerHTML = `<img src="${escapeHtml(user.avatar)}" alt="">`;
    } else {
      avatar.textContent = (user.username || "A").slice(0, 1).toUpperCase();
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

async function initAuthPage() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const box = $("#auth-error");
  if (error && box) {
    box.hidden = false;
    box.textContent = ERROR_MESSAGES[error] || error;
  }
  try {
    const user = await getMe();
    if (user?.isAdmin) window.location.href = "/admin.html";
  } catch {}
}

async function initDashboard() {
  const user = await requireAdminPage();
  if (!user) return;
  setUser(user);
  await loadProducts();
}

async function loadProducts() {
  const root = $("#admin-products");
  if (!root) return;
  root.innerHTML = `<div class="admin-empty">Carregando produtos...</div>`;
  try {
    const { products } = await api("/api/admin/products");
    renderStats(products);
    renderProductsTable(products);
  } catch (error) {
    root.innerHTML = `<div class="admin-empty danger-text">${escapeHtml(error.message)}</div>`;
  }
}

function renderStats(products) {
  const total = products.length;
  const active = products.filter((p) => p.active !== false).length;
  const available = products.filter((p) => p.available).length;
  const unavailable = products.filter((p) => !p.available).length;
  const stats = [
    ["Total de produtos", total],
    ["Ativos na vitrine", active],
    ["Disponíveis", available],
    ["Indisponíveis", unavailable]
  ];
  const root = $("#admin-stats");
  if (!root) return;
  root.innerHTML = stats.map(([label, value]) => `
    <article class="admin-stat card">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>
  `).join("");
}

function renderProductsTable(products) {
  const root = $("#admin-products");
  if (!root) return;
  if (!products.length) {
    root.innerHTML = `<div class="admin-empty">Nenhum produto cadastrado ainda.</div>`;
    return;
  }
  root.innerHTML = `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Produto</th>
            <th>Categoria</th>
            <th>Preço</th>
            <th>Status</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          ${products.map((product) => `
            <tr>
              <td>
                <div class="admin-product-cell">
                  <div class="admin-thumb">${product.image ? `<img src="${escapeHtml(product.image)}" alt="">` : "sem imagem"}</div>
                  <div>
                    <strong>${escapeHtml(product.name)}</strong>
                    <span>${escapeHtml(product.shortDescription || "")}</span>
                  </div>
                </div>
              </td>
              <td>${escapeHtml(product.category || "-")}</td>
              <td class="text-gold"><strong>${moneyBRL(product.price)}</strong></td>
              <td>
                <span class="product-status ${product.available ? "available" : "unavailable"}">${product.available ? "disponível" : "indisponível"}</span>
                ${product.active === false ? `<span class="admin-hidden-tag">oculto</span>` : ""}
              </td>
              <td>
                <div class="admin-actions">
                  <button class="btn btn-outline btn-small" data-toggle="${escapeHtml(product.id)}">${product.available ? "Desativar" : "Ativar"}</button>
                  <a class="btn btn-outline btn-small" href="/admin-product.html?id=${encodeURIComponent(product.id)}">Editar</a>
                  <button class="btn btn-danger btn-small" data-delete="${escapeHtml(product.id)}">Excluir</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  $$('[data-toggle]').forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/admin/products/${encodeURIComponent(button.dataset.toggle)}/toggle`, { method: "POST", body: "{}" });
        await loadProducts();
      } catch (error) {
        alert(error.message);
        button.disabled = false;
      }
    });
  });

  $$('[data-delete]').forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Excluir este produto?")) return;
      button.disabled = true;
      try {
        await api(`/api/admin/products/${encodeURIComponent(button.dataset.delete)}`, { method: "DELETE" });
        await loadProducts();
      } catch (error) {
        alert(error.message);
        button.disabled = false;
      }
    });
  });
}

async function initProductForm() {
  const user = await requireAdminPage();
  if (!user) return;
  setUser(user);
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id") || "novo";
  const isNew = id === "novo";
  $("#form-title").textContent = isNew ? "Novo Produto" : "Editar Produto";
  if (!isNew) {
    try {
      const { product } = await api(`/api/admin/products/${encodeURIComponent(id)}`);
      fillForm(product);
    } catch (error) {
      alert(error.message);
      window.location.href = "/admin.html";
      return;
    }
  }
  setupImageUpload();
  setupPreview();
  $("#product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveProduct(id, isNew);
  });
}

function fillForm(product) {
  $("#product-id").value = product.id || "";
  $("#name").value = product.name || "";
  $("#price").value = product.price ?? 0;
  $("#category").value = product.category || "";
  $("#shortDescription").value = product.shortDescription || "";
  $("#fullDescription").value = product.fullDescription || "";
  $("#image").value = product.image || "";
  $("#available").checked = product.available !== false;
  $("#active").checked = product.active !== false;
  updateImagePreview();
}

function formDataObject(id, isNew) {
  return {
    id: isNew ? null : id,
    name: $("#name").value,
    price: $("#price").value,
    category: $("#category").value,
    shortDescription: $("#shortDescription").value,
    fullDescription: $("#fullDescription").value,
    image: $("#image").value,
    available: $("#available").checked,
    active: $("#active").checked
  };
}

async function saveProduct(id, isNew) {
  const button = $("#save-button");
  button.disabled = true;
  button.textContent = "Salvando...";
  try {
    await api("/api/admin/products", {
      method: "POST",
      body: JSON.stringify(formDataObject(id, isNew))
    });
    window.location.href = "/admin.html";
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Salvar Produto";
  }
}

function setupPreview() {
  const input = $("#image");
  if (input) input.addEventListener("input", updateImagePreview);
  updateImagePreview();
}

function updateImagePreview() {
  const preview = $("#image-preview");
  const url = $("#image")?.value?.trim();
  if (!preview) return;
  preview.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="Preview">` : "sem imagem";
}

function setupImageUpload() {
  const input = $("#image-file");
  const status = $("#upload-status");
  if (!input) return;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    if (status) status.textContent = "Enviando imagem...";
    try {
      const data = await api("/api/admin/upload", { method: "POST", body: form });
      $("#image").value = data.url;
      updateImagePreview();
      if (status) status.textContent = "Imagem enviada.";
    } catch (error) {
      if (status) status.textContent = error.message;
      alert(error.message);
    } finally {
      input.value = "";
    }
  });
}


async function initOrdersPage() {
  const user = await requireAdminPage();
  if (!user) return;
  setUser(user);
  await loadOrders();
}

function orderStatusText(status) {
  return {
    pending_payment: "Aguardando pagamento",
    approved: "Pagamento aprovado",
    delivery_channel_created: "Canal criado",
    delivery_error: "Erro na entrega",
    delivering: "Em entrega",
    delivered: "Entregue",
    canceled: "Cancelado",
    refunded: "Reembolso"
  }[status] || status || "-";
}

function orderStatusClass(status) {
  if (["approved", "delivery_channel_created", "delivering", "delivered"].includes(status)) return "available";
  return "unavailable";
}

function statusOptions(current) {
  const statuses = [
    ["pending_payment", "Aguardando pagamento"],
    ["approved", "Pagamento aprovado"],
    ["delivery_channel_created", "Canal criado"],
    ["delivering", "Em entrega"],
    ["delivered", "Entregue"],
    ["canceled", "Cancelado"],
    ["refunded", "Reembolso"]
  ];
  return statuses.map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`).join("");
}

async function downloadBackup() {
  try {
    const data = await api("/api/admin/backup");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fluxostore-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  }
}

async function orderAction(orderId, action, body = {}) {
  await api(`/api/admin/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  await loadOrders();
}

async function loadOrders() {
  const root = $("#admin-orders");
  if (!root) return;
  root.innerHTML = `<div class="admin-empty">Carregando pedidos...</div>`;
  try {
    const { orders } = await api("/api/admin/orders");
    renderOrderStats(orders);
    if (!orders.length) {
      root.innerHTML = `<div class="admin-empty">Nenhum pedido registrado ainda.</div>`;
      return;
    }
    root.innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Cliente</th>
              <th>Total</th>
              <th>Status</th>
              <th>Entrega</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${orders.map((order) => `
              <tr>
                <td>
                  <strong>${escapeHtml(order.code)}</strong><br>
                  <span class="text-muted">${escapeHtml(new Date(order.createdAt).toLocaleString("pt-BR"))}</span>
                </td>
                <td>
                  <span>${escapeHtml(order.customer?.email || "-")}</span><br>
                  <span class="text-muted">Discord ID: ${escapeHtml(order.customer?.discordId || "-")}</span>
                </td>
                <td class="text-gold"><strong>${moneyBRL(order.total)}</strong></td>
                <td>
                  <span class="product-status ${orderStatusClass(order.status)}">${escapeHtml(orderStatusText(order.status))}</span>
                  ${order.deliveryError ? `<div class="danger-text admin-small-note">${escapeHtml(order.deliveryError)}</div>` : ""}
                </td>
                <td>${order.delivery?.channelUrl ? `<a class="btn btn-outline btn-small" href="${escapeHtml(order.delivery.channelUrl)}" target="_blank" rel="noreferrer">Abrir canal</a>` : `<span class="text-muted">-</span>`}</td>
                <td>
                  <div class="admin-actions admin-actions-wrap">
                    <button class="btn btn-outline btn-small" data-refresh-order="${escapeHtml(order.id)}">Atualizar Pix</button>
                    <button class="btn btn-outline btn-small" data-retry-delivery="${escapeHtml(order.id)}">Criar/Recriar canal</button>
                    <select class="admin-select" data-status-order="${escapeHtml(order.id)}">${statusOptions(order.status)}</select>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    $$("[data-refresh-order]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await orderAction(button.dataset.refreshOrder, "refresh"); }
        catch (error) { alert(error.message); button.disabled = false; }
      });
    });

    $$("[data-retry-delivery]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await orderAction(button.dataset.retryDelivery, "retry-delivery"); }
        catch (error) { alert(error.message); button.disabled = false; }
      });
    });

    $$("[data-status-order]").forEach((select) => {
      select.addEventListener("change", async () => {
        select.disabled = true;
        try { await orderAction(select.dataset.statusOrder, "status", { status: select.value }); }
        catch (error) { alert(error.message); select.disabled = false; }
      });
    });
  } catch (error) {
    root.innerHTML = `<div class="admin-empty danger-text">${escapeHtml(error.message)}</div>`;
  }
}

function renderOrderStats(orders) {
  const root = $("#admin-order-stats");
  if (!root) return;
  const paid = orders.filter((o) => ["approved", "delivery_channel_created", "delivering", "delivered"].includes(o.status)).length;
  const pending = orders.filter((o) => o.status === "pending_payment").length;
  const delivered = orders.filter((o) => o.status === "delivered").length;
  const errors = orders.filter((o) => o.status === "delivery_error" || o.deliveryError).length;
  const stats = [["Pedidos", orders.length], ["Pagos", paid], ["Pendentes", pending], ["Entregues", delivered], ["Erros", errors]];
  root.innerHTML = stats.map(([label, value]) => `<article class="admin-stat card"><span>${label}</span><strong>${value}</strong></article>`).join("");
}

async function initLogsPage() {
  const user = await requireAdminPage();
  if (!user) return;
  setUser(user);
  await loadLogs();
}

async function loadLogs() {
  const root = $("#admin-logs");
  if (!root) return;
  root.innerHTML = `<div class="admin-empty">Carregando logs...</div>`;
  try {
    const { logs } = await api("/api/admin/logs");
    if (!logs.length) {
      root.innerHTML = `<div class="admin-empty">Nenhum log ainda.</div>`;
      return;
    }
    root.innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Data</th><th>Tipo</th><th>Mensagem</th></tr></thead>
          <tbody>
            ${logs.map((log) => `
              <tr>
                <td>${escapeHtml(new Date(log.createdAt).toLocaleString("pt-BR"))}</td>
                <td><span class="product-status available">${escapeHtml(log.type)}</span></td>
                <td>${escapeHtml(log.message || "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    root.innerHTML = `<div class="admin-empty danger-text">${escapeHtml(error.message)}</div>`;
  }
}

document.addEventListener("click", (event) => {
  const backupButton = event.target.closest("[data-download-backup]");
  if (backupButton) downloadBackup();
});

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "auth") initAuthPage();
  if (page === "admin") initDashboard();
  if (page === "admin-product") initProductForm();
  if (page === "admin-orders") initOrdersPage();
  if (page === "admin-logs") initLogsPage();
});
