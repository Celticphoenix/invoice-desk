const app = document.querySelector("#app");
let data = null;
let view = "invoices";
let notice = "";
let editor = null;
let clientEditorId = null;
let serviceEditorId = null;
let campaignEditorId = null;

const revenueCategories = [
  "Services",
  "Products",
  "Consulting",
  "Commission",
  "Other",
];

const today = new Date().toISOString().slice(0, 10);
const dueDefault = new Date(Date.now() + 30 * 86400000)
  .toISOString()
  .slice(0, 10);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(minor, currency) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(
    minor / 100,
  );
}

function minor(value) {
  if (!/^\d+(?:\.\d{0,2})?$/.test(String(value).trim())) return -1;
  const [whole, cents = ""] = String(value).trim().split(".");
  return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
}

function categoryOptions(selected) {
  return revenueCategories
    .map(
      (category) =>
        `<option ${category === selected ? "selected" : ""}>${escapeHtml(category)}</option>`,
    )
    .join("");
}

function paymentMethod(method) {
  if (method === "bank_transfer") return "Interac e-Transfer";
  if (method === "paypal") return "PayPal";
  if (method === "stripe") return "Stripe";
  return "Other";
}

async function request(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Something went wrong");
  return result;
}

async function action(payload, success) {
  notice = "";
  try {
    await request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await request("/api/dashboard");
    notice = success;
  } catch (error) {
    notice = error.message;
  }
  render();
}

function loginScreen(error = "") {
  app.innerHTML = `<section class="login-screen"><form id="login-form" class="login-card"><div class="brand-mark">K</div><p class="kicker">Private internal tool</p><h1>KO Reps Invoice Desk</h1><p>One password. No public accounts. No payment credentials needed.</p>${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}<label>Password<input name="password" type="password" required autofocus autocomplete="current-password" /></label><button class="primary">Open Invoice Desk</button></form></section>`;
  document
    .querySelector("#login-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = new FormData(event.currentTarget).get("password");
      try {
        await request("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        data = await request("/api/dashboard");
        render();
      } catch (failure) {
        loginScreen(failure.message);
      }
    });
}

function shell(content) {
  app.innerHTML = `<header><button class="brand" data-view="invoices"><span class="brand-mark">K</span><span><b>KO Reps Invoice Desk</b><small>Private &amp; internal</small></span></button><nav><button data-view="invoices" class="${view === "invoices" ? "active" : ""}">Invoices</button><button data-view="services" class="${view === "services" ? "active" : ""}">Services &amp; prices</button><button data-view="clients" class="${view === "clients" ? "active" : ""}">Clients</button><button data-view="campaigns" class="${view === "campaigns" ? "active" : ""}">Campaigns</button><button data-view="settings" class="${view === "settings" ? "active" : ""}">Settings</button></nav><button class="signout" id="signout">Sign out</button></header>${notice ? `<div class="toast">${escapeHtml(notice)}</div>` : ""}<main class="page">${content}</main>`;
  document.querySelectorAll("[data-view]").forEach((button) =>
    button.addEventListener("click", () => {
      view = button.dataset.view;
      editor = null;
      clientEditorId = null;
      serviceEditorId = null;
      campaignEditorId = null;
      notice = "";
      render();
    }),
  );
  document.querySelector("#signout").addEventListener("click", async () => {
    await request("/api/logout", { method: "POST" });
    data = null;
    loginScreen();
  });
}

function status(invoice) {
  if (invoice.state === "draft") return ["Draft", "draft"];
  if (invoice.state === "void") return ["Void", "void"];
  if (invoice.paymentStatus === "paid") return ["Paid", "paid"];
  if (invoice.overdue) return ["Overdue", "overdue"];
  if (invoice.paymentStatus === "partially_paid")
    return ["Partly paid", "partial"];
  return ["Awaiting payment", "waiting"];
}

function invoicesScreen() {
  const hasClients = data.clients.length > 0;
  const issued = data.invoices.filter((invoice) => invoice.state === "issued");
  const cad = issued
    .filter((invoice) => invoice.currency === "CAD")
    .reduce((sum, invoice) => sum + invoice.balanceMinor, 0);
  const usd = issued
    .filter((invoice) => invoice.currency === "USD")
    .reduce((sum, invoice) => sum + invoice.balanceMinor, 0);
  const currentMonth = today.slice(0, 7);
  const accountantMonths = [
    ...new Set(
      [
        currentMonth,
        ...data.invoices
          .filter((invoice) => invoice.state !== "draft")
          .map((invoice) => invoice.issueDate.slice(0, 7)),
        ...data.payments.map((payment) => payment.paymentDate.slice(0, 7)),
      ].filter(Boolean),
    ),
  ].sort((left, right) => right.localeCompare(left));
  shell(
    `<section class="hero"><div><p class="kicker">Your invoicing workspace</p><h1>Invoice someone in four simple steps.</h1><p>Create a draft, send it, and keep clear records in one simple workspace.</p></div><button class="primary large" id="new-invoice">${hasClients ? "+ Create invoice" : "+ Add your first client"}</button></section><section class="steps"><b>1. Pick a client</b><span>→</span><b>2. Choose the service</b><span>→</span><b>3. Review and issue</b><span>→</span><b>4. Get paid</b></section><section class="summary"><article><small>Drafts to finish</small><strong>${data.invoices.filter((invoice) => invoice.state === "draft").length}</strong><span>Drafts have no invoice number yet.</span></article><article><small>CAD still to collect</small><strong>${money(cad, "CAD")}</strong><span>CAD stays separate.</span></article><article><small>USD still to collect</small><strong>${money(usd, "USD")}</strong><span>USD stays separate.</span></article></section><section class="accountant-package"><div><p class="kicker">Once-a-month accountant report</p><h2>Pick the month. Download one file.</h2><p>Includes invoice PDFs, invoice and payment spreadsheets, GST/QST totals, and revenue split by service category.</p></div><label>Report month<select id="accountant-period">${accountantMonths.map((month) => `<option value="${month}" ${month === currentMonth ? "selected" : ""}>${new Date(`${month}-02T12:00:00`).toLocaleDateString("en-CA", { month: "long", year: "numeric" })}</option>`).join("")}<option value="">All records</option></select></label><a class="primary large" id="accountant-package" href="/api/export/accountant-package?period=${currentMonth}">Download monthly report</a></section><section class="panel"><div class="panel-title"><div><p class="kicker">All records</p><h2>Invoices</h2></div><div class="actions"><label class="search">Search <input id="search" placeholder="Client or invoice number" /></label><a class="secondary" href="/api/export/invoices">Invoice CSV</a><a class="secondary" href="/api/export/payments">Payment CSV</a></div></div><div id="invoice-list">${invoiceCards(data.invoices)}</div></section>${paymentHistory()}`,
  );
  document.querySelector("#new-invoice").addEventListener("click", () => {
    if (hasClients) return openEditor();
    view = "clients";
    render();
  });
  document.querySelector("#search").addEventListener("input", (event) => {
    const query = event.target.value.toLowerCase();
    document.querySelector("#invoice-list").innerHTML = invoiceCards(
      data.invoices.filter((invoice) =>
        `${invoice.invoiceNumber ?? "draft"} ${invoice.clientName}`
          .toLowerCase()
          .includes(query),
      ),
    );
    bindInvoiceActions();
  });
  document
    .querySelector("#accountant-period")
    .addEventListener("change", (event) => {
      const year = event.target.value;
      document.querySelector("#accountant-package").href = year
        ? `/api/export/accountant-package?period=${encodeURIComponent(year)}`
        : "/api/export/accountant-package";
    });
  bindInvoiceActions();
  bindCorrections();
}

function invoiceCards(invoices) {
  if (!invoices.length)
    return `<div class="empty"><h3>No invoices yet</h3><p>The green button will guide you to the next step.</p></div>`;
  return invoices
    .map((invoice) => {
      const [label, kind] = status(invoice);
      const emailRecord = data.emailOutbox?.find(
        (item) =>
          item.invoiceId === invoice.id && item.recipientType === "client",
      );
      const sendLabel = data.email?.connected
        ? "Review & send invoice"
        : "Finalize & preview email";
      const draftActions =
        invoice.state === "draft"
          ? `<button class="secondary" data-edit="${invoice.id}">Edit draft</button><button class="secondary" data-issue="${invoice.id}">Finalize PDF only</button><button class="primary" data-review-send="${invoice.id}">${sendLabel}</button>`
          : `<a class="secondary" href="/api/pdf/${invoice.id}">Download PDF</a><button class="secondary" data-duplicate="${invoice.id}">Make another like this</button>${emailRecord?.status === "provider_accepted" ? "" : `<button class="primary" data-review-send="${invoice.id}">${sendLabel}</button>`}`;
      const voidAction =
        invoice.state === "issued" && invoice.paymentsMinor === 0
          ? `<button class="danger-link" data-void="${invoice.id}">Void and make replacement</button>`
          : "";
      const payment =
        invoice.state === "issued" && invoice.balanceMinor > 0
          ? `<form class="payment-form" data-payment="${invoice.id}"><b>Paid another way?</b><label>Amount<input name="amount" inputmode="decimal" placeholder="0.00" required /></label><label>How paid<select name="method"><option value="bank_transfer">Interac e-Transfer</option><option value="paypal">PayPal</option><option value="other">Other</option></select></label><label>Confirmation or reference<input name="reference" placeholder="Optional" /></label><button class="primary">Record payment</button></form>`
          : "";
      const checkout = invoice.stripeCheckout;
      const stripeControls =
        invoice.state === "issued" && invoice.balanceMinor > 0
          ? checkout?.status === "open"
            ? `<div class="stripe-box preferred"><div><b>Preferred: pay securely with Stripe</b><span>${checkout.livemode ? "LIVE payment" : "TEST payment"} · ${money(checkout.amountMinor, checkout.currency)}</span></div><div class="invoice-buttons"><a class="primary" href="${escapeHtml(checkout.url)}" target="_blank" rel="noreferrer">Open Stripe payment page</a><button class="secondary" data-copy-stripe="${escapeHtml(checkout.url)}">Copy Stripe link</button><button class="text-button" data-stripe-sync>Check payment status</button></div></div>`
            : data.stripe?.enabled
              ? `<div class="stripe-box preferred"><div><b>Preferred: pay securely with Stripe</b><span>${data.stripe.mode === "test" ? "TEST MODE - no real charge" : "Creates a secure link for the exact balance"}</span></div><button class="primary" data-stripe-create="${invoice.id}">Create Stripe payment link</button></div>`
              : `<div class="stripe-box"><div><b>Stripe is not connected</b><span>Configure it once, then create exact payment links here.</span></div><button class="secondary" data-stripe-settings>Stripe setup</button></div>`
          : "";
      const emailStatus = emailRecord
        ? `<div class="email-box ${emailRecord.status}"><div><b>${emailRecord.status === "provider_accepted" ? "Gmail accepted this email" : emailRecord.status === "failed" ? "Email needs attention" : "Email preview ready"}</b><span>To ${escapeHtml(emailRecord.recipientEmail)}${emailRecord.acceptedAt ? ` · ${escapeHtml(emailRecord.acceptedAt.slice(0, 10))}` : ""}</span></div>${emailRecord.status === "failed" ? `<button class="primary" data-retry-email="${emailRecord.id}">Retry email</button>` : emailRecord.status === "preview" ? `<details><summary>Read preview</summary><pre>${escapeHtml(emailRecord.bodyText)}</pre></details>` : ""}</div>`
        : "";
      return `<article class="invoice-card"><div class="invoice-main"><div><span class="badge ${kind}">${label}</span><h3>${escapeHtml(invoice.invoiceNumber ?? "Unnumbered draft")}</h3><p>${escapeHtml(invoice.clientName)} · Due ${escapeHtml(invoice.dueDate)}</p></div><div class="amount"><strong>${money(invoice.totalMinor, invoice.currency)}</strong><span>${invoice.state === "issued" ? `${money(invoice.balanceMinor, invoice.currency)} remaining` : invoice.currency}</span></div></div><div class="invoice-buttons">${draftActions}${voidAction}</div>${emailStatus}${stripeControls}${payment}${invoice.voidReason ? `<p class="void-note">Reason: ${escapeHtml(invoice.voidReason)}</p>` : ""}</article>`;
    })
    .join("");
}

function bindInvoiceActions() {
  document
    .querySelectorAll("[data-edit]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        openEditor(
          data.invoices.find((invoice) => invoice.id === button.dataset.edit),
        ),
      ),
    );
  document.querySelectorAll("[data-issue]").forEach((button) =>
    button.addEventListener("click", () => {
      if (
        confirm(
          "Issue this invoice? Its details will be frozen and it will receive the next number.",
        )
      )
        action(
          { action: "issue", invoiceId: button.dataset.issue },
          "Invoice issued and its PDF saved.",
        );
    }),
  );
  document.querySelectorAll("[data-duplicate]").forEach((button) =>
    button.addEventListener("click", () =>
      action(
        { action: "duplicate", invoiceId: button.dataset.duplicate },
        "A new draft was created with the same client and services.",
      ),
    ),
  );
  document.querySelectorAll("[data-review-send]").forEach((button) =>
    button.addEventListener("click", () => {
      const message = data.email?.connected
        ? "Finalize this invoice and send it from the connected Gmail account?"
        : "Finalize this invoice and create a safe email preview? Nothing will be sent.";
      if (confirm(message))
        action(
          { action: "review-send", invoiceId: button.dataset.reviewSend },
          data.email?.connected
            ? "Gmail accepted the invoice email."
            : "Email preview created. Nothing was sent.",
        );
    }),
  );
  document.querySelectorAll("[data-retry-email]").forEach((button) =>
    button.addEventListener("click", () =>
      action(
        { action: "retry-email", outboxId: button.dataset.retryEmail },
        data.email?.connected
          ? "Email retry accepted by Gmail."
          : "Preview refreshed. Connect Gmail before sending.",
      ),
    ),
  );
  document.querySelectorAll("[data-void]").forEach((button) =>
    button.addEventListener("click", () => {
      const reason = prompt("Why are you voiding this unpaid invoice?");
      if (reason)
        action(
          { action: "void-reissue", invoiceId: button.dataset.void, reason },
          "Original voided. A linked replacement draft is ready.",
        );
    }),
  );
  document.querySelectorAll("[data-payment]").forEach((form) =>
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const invoice = data.invoices.find(
        (item) => item.id === form.dataset.payment,
      );
      const amountMinor = minor(values.get("amount"));
      if (amountMinor < 1) return alert("Enter a valid payment amount.");
      action(
        {
          action: "record-payment",
          payment: {
            invoiceId: invoice.id,
            paymentDate: today,
            method: values.get("method"),
            amountMinor,
            currency: invoice.currency,
            reference: values.get("reference"),
            notes: "",
          },
        },
        "Payment recorded. The balance is updated.",
      );
    }),
  );
  document
    .querySelectorAll("[data-stripe-create]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(
          { action: "stripe-create", invoiceId: button.dataset.stripeCreate },
          "Stripe payment link created for the exact remaining balance.",
        ),
      ),
    );
  document
    .querySelectorAll("[data-stripe-sync]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action({ action: "stripe-sync" }, "Stripe payment status checked."),
      ),
    );
  document.querySelectorAll("[data-copy-stripe]").forEach((button) =>
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyStripe);
        notice =
          "Stripe payment link copied. You can paste it into an email or message.";
      } catch {
        notice =
          "Could not copy automatically. Open the payment page and copy its address.";
      }
      render();
    }),
  );
  document.querySelectorAll("[data-stripe-settings]").forEach((button) =>
    button.addEventListener("click", () => {
      view = "settings";
      render();
    }),
  );
}

function paymentHistory() {
  if (!data.payments.length) return "";
  return `<section class="panel"><div class="panel-title"><div><p class="kicker">Audit-friendly</p><h2>Payment history</h2></div><p>Gross customer payments. Fees are never guessed.</p></div><div class="payment-history">${data.payments.map((payment) => `<div class="${payment.status === "corrected" ? "corrected" : ""}"><b>${escapeHtml(payment.invoiceNumber)}</b><span>${escapeHtml(payment.paymentDate)}<small>${escapeHtml(paymentMethod(payment.method))}</small></span><span>${escapeHtml(payment.reference || "No reference")}</span><b>${money(payment.amountMinor, payment.currency)}</b>${payment.status === "active" ? `<button class="text-button" data-correct="${payment.id}">Correct</button>` : `<em>Corrected</em>`}</div>`).join("")}</div></section>`;
}

function bindCorrections() {
  document.querySelectorAll("[data-correct]").forEach((button) =>
    button.addEventListener("click", () => {
      const payment = data.payments.find(
        (item) => item.id === button.dataset.correct,
      );
      const next = prompt(
        "Enter the corrected amount",
        (payment.amountMinor / 100).toFixed(2),
      );
      if (next === null || minor(next) < 1) return;
      const reference =
        prompt("Reference for the corrected entry", payment.reference) ??
        payment.reference;
      action(
        {
          action: "correct-payment",
          correction: {
            paymentId: payment.id,
            amountMinor: minor(next),
            reference,
            notes: "Corrected in Payment history",
          },
        },
        "Payment corrected. The original remains in the audit history.",
      );
    }),
  );
}

function openEditor(invoice = null) {
  editor = invoice
    ? {
        id: invoice.id,
        clientId: invoice.clientId,
        currency: invoice.currency,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        terms: invoice.terms,
        notes: invoice.notes,
        lines: invoice.lines.map(
          ({ description, quantity, rateMinor, category, serviceId }) => ({
          description,
          quantity,
          rateMinor,
            category: category ?? "Other",
            serviceId: serviceId ?? "",
          }),
        ),
        taxes: invoice.taxes.map(
          ({ label, rateThousandths, rateBasisPoints }) => ({
            label,
            rateThousandths: rateThousandths ?? rateBasisPoints * 10,
          }),
        ),
      }
    : {
        id: null,
        clientId: data.clients[0]?.id ?? "",
        currency: "CAD",
        issueDate: today,
        dueDate: dueDefault,
        terms: "Payment due within 30 days.",
        notes: "Thank you for your business.",
        lines: [
          {
            description: "",
            quantity: "1",
            rateMinor: 0,
            category: "Other",
            serviceId: "",
          },
        ],
        taxes: [],
      };
  view = "editor";
  renderEditor();
}

function editorTotals() {
  const subtotal = editor.lines.reduce(
    (sum, line) =>
      sum + Math.round(Number(line.quantity || 0) * line.rateMinor),
    0,
  );
  const tax = editor.taxes.reduce(
    (sum, item) => sum + Math.round((subtotal * item.rateThousandths) / 100000),
    0,
  );
  return { subtotal, total: subtotal + tax };
}

function renderEditor() {
  const totals = editorTotals();
  shell(
    `<section class="composer"><div class="composer-title"><div><p class="kicker">Draft - nothing is sent</p><h1>${editor.id ? "Edit your draft" : "Create an invoice"}</h1><p>Complete four short sections, then save and review.</p></div><div class="total-box"><small>Invoice total</small><strong id="live-total">${money(totals.total, editor.currency)}</strong></div></div><form id="invoice-form"><section class="form-section"><span class="number">1</span><div><h2>Who is this for?</h2><div class="grid"><label class="wide">Client<select name="clientId">${data.clients.map((client) => `<option value="${client.id}" ${client.id === editor.clientId ? "selected" : ""}>${escapeHtml(client.name)}${client.company ? ` - ${escapeHtml(client.company)}` : ""}</option>`).join("")}</select></label><label>Currency<select name="currency"><option ${editor.currency === "CAD" ? "selected" : ""}>CAD</option><option ${editor.currency === "USD" ? "selected" : ""}>USD</option></select><small>Never combined or converted.</small></label><label>Invoice date<input name="issueDate" type="date" value="${editor.issueDate}" required /></label><label>Payment due<input name="dueDate" type="date" value="${editor.dueDate}" required /></label></div></div></section><section class="form-section"><span class="number">2</span><div><h2>What are you billing for?</h2><p class="helper">Choose a saved service to fill in its normal description and price. You can still change anything on this invoice.</p><div id="lines">${editor.lines.map((line, index) => `<div class="line-row"><label class="service-picker">Saved service<select data-line="${index}" data-field="serviceId"><option value="">Choose a service…</option>${data.services.filter((service) => service.currency === editor.currency).map((service) => `<option value="${service.id}" ${service.id === line.serviceId ? "selected" : ""}>${escapeHtml(service.name)} — ${money(service.rateMinor, service.currency)}</option>`).join("")}</select></label><label class="description-field">Description on invoice<input data-line="${index}" data-field="description" value="${escapeHtml(line.description)}" required /></label><label>Revenue type<select data-line="${index}" data-field="category">${categoryOptions(line.category ?? "Other")}</select></label><label>Quantity<input data-line="${index}" data-field="quantity" value="${escapeHtml(line.quantity)}" inputmode="decimal" required /></label><label>Rate (${editor.currency})<input data-line="${index}" data-field="rate" value="${(line.rateMinor / 100).toFixed(2)}" inputmode="decimal" required /></label>${editor.lines.length > 1 ? `<button type="button" class="remove" data-remove-line="${index}" aria-label="Remove service">×</button>` : ""}</div>`).join("")}</div><div class="invoice-shortcuts"><button type="button" class="text-button" id="add-line">+ Add another service</button><button type="button" class="secondary" data-add-percentage="Commission">Calculate percentage fee</button></div></div></section><section class="form-section"><span class="number">3</span><div><h2>Is this invoice taxable in Québec?</h2><p class="helper">Choose the green button for the normal Québec GST and QST. Leave this section empty for a non-taxable invoice.</p><div id="taxes">${editor.taxes.map((tax, index) => `<div class="tax-row"><label>Tax label<input data-tax="${index}" data-field="label" value="${escapeHtml(tax.label)}" required /></label><label>Rate %<input data-tax="${index}" data-field="rate" type="number" min="0" max="100" step="0.001" value="${(tax.rateThousandths / 1000).toFixed(3).replace(/\.?0+$/, "")}" required /></label><button type="button" class="remove" data-remove-tax="${index}" aria-label="Remove tax">×</button></div>`).join("")}</div><div class="tax-actions"><button type="button" class="primary" id="add-quebec-tax">Yes — add GST + QST</button><button type="button" class="text-button" id="add-tax">Add a different tax</button></div></div></section><section class="form-section"><span class="number">4</span><div><h2>Final notes</h2><div class="grid"><label>Payment terms<textarea name="terms">${escapeHtml(editor.terms)}</textarea></label><label>Note on invoice<textarea name="notes">${escapeHtml(editor.notes)}</textarea></label></div></div></section><footer class="form-footer"><button type="button" class="secondary" id="cancel-editor">Cancel</button><span>This only saves a draft. Nothing is sent.</span><button class="primary large">Save draft and review →</button></footer></form></section>`,
  );
  bindEditor();
}

function bindEditor() {
  const form = document.querySelector("#invoice-form");
  form.addEventListener("input", (event) => {
    const target = event.target;
    if (target.dataset.line !== undefined) {
      const line = editor.lines[Number(target.dataset.line)];
      if (target.dataset.field === "serviceId") {
        const service = data.services.find(
          (item) => item.id === target.value,
        );
        line.serviceId = target.value;
        if (service) {
          line.description = service.description;
          line.rateMinor = service.rateMinor;
          line.category = service.category;
        }
        renderEditor();
        return;
      } else if (target.dataset.field === "rate")
        line.rateMinor = Math.max(0, minor(target.value));
      else line[target.dataset.field] = target.value;
    }
    if (target.dataset.tax !== undefined) {
      const tax = editor.taxes[Number(target.dataset.tax)];
      if (target.dataset.field === "rate")
        tax.rateThousandths = Math.round(Number(target.value) * 1000);
      else tax.label = target.value;
    }
    if (
      target.name &&
      [
        "clientId",
        "currency",
        "issueDate",
        "dueDate",
        "terms",
        "notes",
      ].includes(target.name)
    )
      editor[target.name] = target.value;
    document.querySelector("#live-total").textContent = money(
      editorTotals().total,
      editor.currency,
    );
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(
      { action: "save-draft", invoiceId: editor.id, invoice: editor },
      editor.id
        ? "Draft updated."
        : "Draft saved. Review it below before issuing.",
    );
    view = "invoices";
    editor = null;
  });
  document.querySelector("#cancel-editor").addEventListener("click", () => {
    view = "invoices";
    editor = null;
    render();
  });
  document.querySelector("#add-line").addEventListener("click", () => {
    editor.lines.push({
      description: "",
      quantity: "1",
      rateMinor: 0,
      category: "Other",
      serviceId: "",
    });
    renderEditor();
  });
  document.querySelectorAll("[data-add-percentage]").forEach((button) =>
    button.addEventListener("click", () => {
      const base = prompt(
        "Enter the amount the percentage is based on",
        "0.00",
      );
      if (base === null || minor(base) < 0)
        return alert("Enter a valid total amount.");
      const percent = prompt("Enter the percentage fee", "10");
      if (
        percent === null ||
        !/^\d+(?:\.\d{1,3})?$/.test(percent.trim()) ||
        Number(percent) > 100
      )
        return alert("Enter a valid percentage from 0 to 100.");
      const amountMinor = Math.round((minor(base) * Number(percent)) / 100);
      const category = "Commission";
      const description = `Percentage fee (${percent.trim()}%)`;
      const line = {
        description,
        quantity: "1",
        rateMinor: amountMinor,
        category,
        serviceId: "",
      };
      if (
        editor.lines.length === 1 &&
        !editor.lines[0].description &&
        editor.lines[0].rateMinor === 0
      )
        editor.lines[0] = line;
      else editor.lines.push(line);
      renderEditor();
    }),
  );
  document.querySelector("#add-tax").addEventListener("click", () => {
    editor.taxes.push({ label: "Tax", rateThousandths: 0 });
    renderEditor();
  });
  document.querySelector("#add-quebec-tax").addEventListener("click", () => {
    const labels = new Set(editor.taxes.map((tax) => tax.label.toUpperCase()));
    if (!labels.has("GST"))
      editor.taxes.push({ label: "GST", rateThousandths: 5000 });
    if (!labels.has("QST"))
      editor.taxes.push({ label: "QST", rateThousandths: 9975 });
    renderEditor();
  });
  document.querySelectorAll("[data-remove-line]").forEach((button) =>
    button.addEventListener("click", () => {
      editor.lines.splice(Number(button.dataset.removeLine), 1);
      renderEditor();
    }),
  );
  document.querySelectorAll("[data-remove-tax]").forEach((button) =>
    button.addEventListener("click", () => {
      editor.taxes.splice(Number(button.dataset.removeTax), 1);
      renderEditor();
    }),
  );
}

function clientsScreen() {
  const editing = data.clients.find((client) => client.id === clientEditorId);
  const marketingStatus = editing?.marketingStatus ?? "needs_review";
  shell(
    `<section class="simple"><p class="kicker">Saved address book · ${data.clients.length} clients</p><h1>Clients</h1><p>Add a client once, then choose them on every future invoice. Marketing permission is kept separate from ordinary invoice email.</p><div class="two-column"><form class="card-form" id="client-form"><h2>${editing ? "Edit client" : "Add a client"}</h2><label>Name<input name="name" value="${escapeHtml(editing?.name ?? "")}" required /></label><label>Email <small>optional until you need to send an invoice</small><input name="email" type="email" value="${escapeHtml(editing?.email ?? "")}" /></label><label>Company <small>optional</small><input name="company" value="${escapeHtml(editing?.company ?? "")}" /></label><label>Phone <small>optional</small><input name="phone" value="${escapeHtml(editing?.phone ?? "")}" /></label><label>Billing address<textarea name="address">${escapeHtml(editing?.address ?? "")}</textarea></label><label>Private notes <small>never shown on invoices</small><textarea name="notes">${escapeHtml(editing?.notes ?? "")}</textarea></label><fieldset class="permission-box"><legend>Marketing email permission</legend><p>Invoices do not require this setting. Campaigns do.</p><label>Status<select name="marketingStatus"><option value="needs_review" ${marketingStatus === "needs_review" ? "selected" : ""}>Needs review — do not market</option><option value="express" ${marketingStatus === "express" ? "selected" : ""}>Express consent</option><option value="implied" ${marketingStatus === "implied" ? "selected" : ""}>Implied consent with expiry</option><option value="unsubscribed" ${marketingStatus === "unsubscribed" ? "selected" : ""}>Unsubscribed — always block</option></select></label><label>How permission was obtained <small>required for express consent</small><input name="marketingConsentSource" value="${escapeHtml(editing?.marketingConsentSource ?? "")}" placeholder="Example: signed form or phone call" /></label><div class="grid"><label>Permission date <small>optional</small><input type="date" name="marketingConsentAt" value="${escapeHtml(editing?.marketingConsentAt ?? "")}" /></label><label>Implied-consent expiry <small>required for implied consent</small><input type="date" name="marketingConsentExpiresAt" value="${escapeHtml(editing?.marketingConsentExpiresAt ?? "")}" /></label></div></fieldset><div class="form-buttons">${editing ? `<button type="button" class="secondary" id="cancel-client-edit">Cancel</button>` : ""}<button class="primary">${editing ? "Save changes" : "+ Save client"}</button></div></form><div class="client-list">${data.clients.map((client) => `<article><span class="avatar">${escapeHtml(client.name[0])}</span><div><h3>${escapeHtml(client.name)}</h3><p>${escapeHtml(client.company || "Individual")}</p><small>${escapeHtml(client.email || "Email not added yet")}${client.phone ? ` · ${escapeHtml(client.phone)}` : ""}</small><span class="permission-badge ${client.marketing.eligible ? "allowed" : client.marketingStatus === "unsubscribed" ? "blocked" : "review"}">${client.marketing.eligible ? "Campaigns allowed" : escapeHtml(client.marketing.reason)}</span></div><button class="secondary" data-edit-client="${client.id}">Edit</button></article>`).join("")}</div></div></section>`,
  );
  document.querySelector("#client-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(
      {
        action: editing ? "save-client" : "create-client",
        clientId: editing?.id,
        client: Object.fromEntries(new FormData(event.currentTarget)),
      },
      editing ? "Client details updated." : "Client saved and ready to invoice.",
    );
    clientEditorId = null;
  });
  document.querySelectorAll("[data-edit-client]").forEach((button) =>
    button.addEventListener("click", () => {
      clientEditorId = button.dataset.editClient;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }),
  );
  document.querySelector("#cancel-client-edit")?.addEventListener("click", () => {
    clientEditorId = null;
    render();
  });
}

function campaignsScreen() {
  const eligible = data.clients.filter((client) => client.marketing.eligible);
  const blocked = data.clients.length - eligible.length;
  const editing = data.campaigns?.find((campaign) => campaign.id === campaignEditorId && campaign.status === "draft");
  const selected = new Set(editing?.recipients.map((recipient) => recipient.clientId) ?? []);
  const history = data.campaigns ?? [];
  shell(
    `<section class="simple campaigns"><p class="kicker">Consent-aware email</p><h1>Campaigns</h1><p>Choose approved clients and send each person a separate email through the connected Gmail account. Nobody can see anyone else’s address.</p><div class="campaign-safety"><b>${eligible.length} eligible · ${blocked} blocked or needing review</b><span>Maximum 50 recipients per campaign. Unsubscribed and expired contacts are automatically excluded.</span></div><div class="two-column"><form class="card-form" id="campaign-form"><h2>${editing ? "Edit campaign" : "Create a campaign"}</h2><label>Internal campaign name<input name="name" value="${escapeHtml(editing?.name ?? "")}" placeholder="Example: September update" required /></label><label>Email subject<input name="subject" value="${escapeHtml(editing?.subject ?? "")}" required /></label><label>Message <small>the greeting, business address and unsubscribe instructions are added automatically</small><textarea name="bodyText" rows="9" required>${escapeHtml(editing?.bodyText ?? "")}</textarea></label><fieldset class="recipient-picker"><legend>Who should receive it?</legend>${eligible.length ? `<label class="select-all"><input type="checkbox" id="select-all" ${selected.size === eligible.length && eligible.length ? "checked" : ""} /> Select all eligible clients</label><div>${eligible.map((client) => `<label><input type="checkbox" name="clientIds" value="${client.id}" ${selected.has(client.id) ? "checked" : ""} /> <span>${escapeHtml(client.name)}<small>${escapeHtml(client.email)}</small></span></label>`).join("")}</div>` : `<p>No clients are approved for marketing yet. Open Clients and record permission first.</p>`}</fieldset><div class="form-buttons">${editing ? `<button type="button" class="secondary" id="cancel-campaign-edit">Cancel</button>` : ""}<button class="primary" ${eligible.length ? "" : "disabled"}>Save draft</button></div></form><div class="campaign-history"><h2>Campaign history</h2>${history.length ? history.map((campaign) => { const sent = campaign.recipients.filter((r) => r.status === "sent").length; const failed = campaign.recipients.filter((r) => r.status === "failed").length; const skipped = campaign.recipients.filter((r) => r.status === "skipped").length; return `<article><div><span class="permission-badge ${campaign.status === "sent" ? "allowed" : campaign.status === "partial" ? "blocked" : "review"}">${escapeHtml(campaign.status)}</span><h3>${escapeHtml(campaign.name)}</h3><p>${escapeHtml(campaign.subject)}</p><small>${campaign.recipients.length} selected · ${sent} sent${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""}</small><details><summary>Preview message</summary><pre>Hello [client name],\n\n${escapeHtml(campaign.bodyText)}\n\n— Business identity and unsubscribe instructions are added automatically —</pre></details></div><div class="campaign-actions">${campaign.status === "draft" ? `<button class="secondary" data-edit-campaign="${campaign.id}">Edit</button><button class="primary" data-send-campaign="${campaign.id}" data-count="${campaign.recipients.length}">Review &amp; send</button>` : campaign.status === "partial" && failed ? `<button class="primary" data-send-campaign="${campaign.id}" data-count="${failed}">Retry failed</button>` : ""}</div></article>`; }).join("") : `<div class="empty"><h3>No campaigns yet</h3><p>Your first saved draft will appear here.</p></div>`}</div></div><section class="legal-note"><b>Simple safety rules</b><p>Only record express consent when the person actually agreed. For implied consent, enter the expiry date. If anyone asks to stop, mark them Unsubscribed in Clients right away. The app does not use tracking pixels.</p></section></section>`,
  );
  document.querySelector("#campaign-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    action(
      {
        action: "save-campaign",
        campaignId: editing?.id,
        campaign: {
          name: form.get("name"),
          subject: form.get("subject"),
          bodyText: form.get("bodyText"),
          clientIds: form.getAll("clientIds"),
        },
      },
      "Campaign draft saved. Nothing has been sent.",
    );
    campaignEditorId = null;
  });
  document.querySelector("#select-all")?.addEventListener("change", (event) => {
    document.querySelectorAll('input[name="clientIds"]').forEach((input) => {
      input.checked = event.target.checked;
    });
  });
  document.querySelectorAll("[data-edit-campaign]").forEach((button) =>
    button.addEventListener("click", () => {
      campaignEditorId = button.dataset.editCampaign;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }),
  );
  document.querySelector("#cancel-campaign-edit")?.addEventListener("click", () => {
    campaignEditorId = null;
    render();
  });
  document.querySelectorAll("[data-send-campaign]").forEach((button) =>
    button.addEventListener("click", () => {
      const count = Number(button.dataset.count);
      if (!confirm(`Send this campaign as ${count} separate email${count === 1 ? "" : "s"}?\n\nOnly eligible clients will be sent. This cannot be undone.`)) return;
      action(
        { action: "send-campaign", campaignId: button.dataset.sendCampaign },
        "Campaign send finished. Check the campaign card for the exact result.",
      );
    }),
  );
}

function servicesScreen() {
  const editing = data.services.find((service) => service.id === serviceEditorId);
  shell(
    `<section class="simple"><p class="kicker">Saved menu · ${data.services.length} services</p><h1>Services &amp; prices</h1><p>Save a service once. Choosing it on an invoice fills in the normal description, category, and price automatically.</p><div class="two-column"><form class="card-form" id="service-form"><h2>${editing ? "Edit service" : "Add a service"}</h2><label>Short service name<input name="name" value="${escapeHtml(editing?.name ?? "")}" placeholder="Example: Consulting session" required /></label><label>Description shown on invoice<textarea name="description" required>${escapeHtml(editing?.description ?? "")}</textarea></label><label>Revenue type<select name="category">${categoryOptions(editing?.category ?? "Services")}</select></label><div class="grid"><label>Currency<select name="currency"><option ${editing?.currency !== "USD" ? "selected" : ""}>CAD</option><option ${editing?.currency === "USD" ? "selected" : ""}>USD</option></select></label><label>Normal price<input name="rate" inputmode="decimal" value="${editing ? (editing.rateMinor / 100).toFixed(2) : ""}" placeholder="0.00" required /></label></div><div class="form-buttons">${editing ? `<button type="button" class="secondary" id="cancel-service-edit">Cancel</button>` : ""}<button class="primary">${editing ? "Save changes" : "+ Save service"}</button></div></form><div class="service-list">${revenueCategories.map((category) => { const services = data.services.filter((service) => service.category === category); return services.length ? `<section><h2>${escapeHtml(category)}</h2>${services.map((service) => `<article><div><h3>${escapeHtml(service.name)}</h3><p>${escapeHtml(service.description)}</p></div><b>${money(service.rateMinor, service.currency)}</b><button class="secondary" data-edit-service="${service.id}">Edit</button></article>`).join("")}</section>` : ""; }).join("") || `<div class="empty"><h3>No saved services yet</h3><p>Add the services you use most often.</p></div>`}</div></div></section>`,
  );
  document.querySelector("#service-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const rateMinor = minor(values.rate);
    if (rateMinor < 0) return alert("Enter a valid price.");
    delete values.rate;
    values.rateMinor = rateMinor;
    action(
      {
        action: "save-service",
        serviceId: editing?.id,
        service: values,
      },
      editing ? "Service updated." : "Service saved and ready to use.",
    );
    serviceEditorId = null;
  });
  document.querySelectorAll("[data-edit-service]").forEach((button) =>
    button.addEventListener("click", () => {
      serviceEditorId = button.dataset.editService;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }),
  );
  document.querySelector("#cancel-service-edit")?.addEventListener("click", () => {
    serviceEditorId = null;
    render();
  });
}

function settingsScreen() {
  const s = data.settings;
  const stripe = data.stripe ?? { enabled: false, mode: "not configured" };
  const email = data.email ?? {
    configured: false,
    connected: false,
    mode: "preview",
  };
  const emailPanel = `<section class="stripe-settings email-settings"><div><p class="kicker">Invoice email</p><h2>Gmail delivery</h2><p>${email.connected ? `<b>Connected as ${escapeHtml(email.email)}.</b> Review &amp; Send will attach the saved PDF and send it through Gmail. The app can send only; it cannot read the account owner's inbox.` : email.configured ? `<b>Ready for one-time approval.</b> Click Connect Gmail, sign into ${escapeHtml(s.email)}, and approve send-only access.` : `<b>Safe preview mode is active.</b> Review &amp; Send creates the exact email without transmitting it. To enable Gmail, first double-click <code>Configure Gmail.cmd</code> in the Invoice Desk folder and add Google OAuth credentials.`}</p></div><div class="email-connect-actions">${email.connected ? `<span class="stripe-status connected">CONNECTED</span><button class="text-button" id="disconnect-gmail">Disconnect</button>` : email.configured ? `<a class="primary" href="/api/gmail/connect">Connect ${escapeHtml(s.email)}</a>` : `<span class="stripe-status">PREVIEW ONLY</span>`}</div></section>`;
  const stripePanel = `<section class="stripe-settings"><div><p class="kicker">Card payments</p><h2>Stripe</h2><p>${stripe.enabled ? `<b>${stripe.mode === "live" ? "Live payments connected" : "Test mode connected"}.</b> Invoice Desk creates a hosted Checkout page for the exact unpaid balance and checks Stripe whenever the dashboard loads.` : `<b>Not connected yet.</b> When you have your Stripe test key, double-click <code>Configure Stripe.cmd</code> in the Invoice Desk folder. Your secret key is stored as a Windows user environment variable, never in this form or the database.`}</p>${stripe.error ? `<p class="stripe-error">Last Stripe check: ${escapeHtml(stripe.error)}</p>` : ""}</div><div class="stripe-status ${stripe.enabled ? "connected" : ""}">${stripe.enabled ? escapeHtml(stripe.mode.toUpperCase()) : "NOT CONNECTED"}</div></section>`;
  shell(
    `<section class="simple"><p class="kicker">Used on future invoices</p><h1>Business settings</h1><p>Every new invoice is issued by the business shown here. Issued invoices keep their original details when settings change.</p><form class="card-form settings" id="settings-form"><div class="grid"><label>Business name<input name="name" value="${escapeHtml(s.name)}" required /></label><label>Billing email<input name="email" type="email" value="${escapeHtml(s.email)}" required /></label><label>Business address<textarea name="address">${escapeHtml(s.address)}</textarea></label><label>Logo URL <small>optional</small><input name="logoUrl" type="url" value="${escapeHtml(s.logoUrl)}" /></label><label>GST registration number <small>add when you have it</small><input name="gstNumber" value="${escapeHtml(s.gstNumber)}" placeholder="123456789RT0001" /></label><label>QST registration number <small>add when you have it</small><input name="qstNumber" value="${escapeHtml(s.qstNumber)}" placeholder="1234567890TQ0001" /></label><label>Accountant email <small>shown beside the monthly report</small><input name="accountantEmail" type="email" value="${escapeHtml(s.accountantEmail)}" /></label><label>Interac e-Transfer email <small>payment alternative</small><input name="etransferEmail" type="email" value="${escapeHtml(s.etransferEmail)}" /></label><label>PayPal fallback link <small>payment alternative</small><input name="paypalFallbackUrl" type="url" value="${escapeHtml(s.paypalFallbackUrl)}" /></label><label>Payment instructions<textarea name="paymentInstructions">${escapeHtml(s.paymentInstructions)}</textarea></label><label>Invoice prefix<input name="invoicePrefix" value="${escapeHtml(s.invoicePrefix)}" pattern="[A-Z0-9-]+" required /></label><label>Next invoice number<input name="nextInvoiceNumber" type="number" min="1" value="${s.nextInvoiceNumber}" required /></label></div><button class="primary">Save settings</button></form>${emailPanel}${stripePanel}</section>`,
  );
  document
    .querySelector("#settings-form")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      values.nextInvoiceNumber = Number(values.nextInvoiceNumber);
      action(
        { action: "save-settings", settings: values },
        "Business settings saved.",
      );
    });
  document.querySelector("#disconnect-gmail")?.addEventListener("click", () => {
    if (confirm("Disconnect Gmail from Invoice Desk? Existing email records stay saved."))
      action(
        { action: "disconnect-gmail" },
        "Gmail disconnected. Email preview mode is active.",
      );
  });
}

function render() {
  if (!data) return loginScreen();
  if (view === "editor") return renderEditor();
  if (view === "services") return servicesScreen();
  if (view === "clients") return clientsScreen();
  if (view === "campaigns") return campaignsScreen();
  if (view === "settings") return settingsScreen();
  invoicesScreen();
}

try {
  const session = await request("/api/session");
  if (session.authenticated) data = await request("/api/dashboard");
  render();
} catch (error) {
  app.innerHTML = `<section class="login-screen"><div class="login-card"><h1>Invoice Desk could not start</h1><p>${escapeHtml(error.message)}</p></div></section>`;
}
