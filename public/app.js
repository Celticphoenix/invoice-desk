const app = document.querySelector("#app");
let data = null;
let view = "invoices";
let notice = "";
let editor = null;

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
  app.innerHTML = `<section class="login-screen"><form id="login-form" class="login-card"><div class="brand-mark">N</div><p class="kicker">Private internal tool</p><h1>Invoice Desk</h1><p>One password. No public accounts. No payment credentials needed.</p>${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}<label>Password<input name="password" type="password" required autofocus autocomplete="current-password" /></label><button class="primary">Open Invoice Desk</button><small>Local demo password: <code>invoice-demo</code></small></form></section>`;
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
  app.innerHTML = `<header><button class="brand" data-view="invoices"><span class="brand-mark">N</span><span><b>Invoice Desk</b><small>Private &amp; internal</small></span></button><nav><button data-view="invoices" class="${view === "invoices" ? "active" : ""}">Invoices</button><button data-view="clients" class="${view === "clients" ? "active" : ""}">Clients</button><button data-view="settings" class="${view === "settings" ? "active" : ""}">Settings</button></nav><button class="signout" id="signout">Sign out</button></header>${notice ? `<div class="toast">${escapeHtml(notice)}</div>` : ""}<main class="page">${content}</main>`;
  document.querySelectorAll("[data-view]").forEach((button) =>
    button.addEventListener("click", () => {
      view = button.dataset.view;
      editor = null;
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
  const accountantYears = [
    ...new Set(
      [
        ...data.invoices
          .filter((invoice) => invoice.state !== "draft")
          .map((invoice) => invoice.issueDate.slice(0, 4)),
        ...data.payments.map((payment) => payment.paymentDate.slice(0, 4)),
      ].filter(Boolean),
    ),
  ].sort((left, right) => right.localeCompare(left));
  shell(
    `<section class="hero"><div><p class="kicker">Your invoicing workspace</p><h1>Invoices, without the fuss.</h1><p>Create a draft, check it, issue it, then record what was paid.</p></div><button class="primary large" id="new-invoice">${hasClients ? "+ Create invoice" : "+ Add your first client"}</button></section><section class="steps"><b>1. Pick a client</b><span>→</span><b>2. Make a draft</b><span>→</span><b>3. Review and issue</b><span>→</span><b>4. Record payment</b></section><section class="summary"><article><small>Drafts to finish</small><strong>${data.invoices.filter((invoice) => invoice.state === "draft").length}</strong><span>Drafts have no invoice number yet.</span></article><article><small>CAD still to collect</small><strong>${money(cad, "CAD")}</strong><span>CAD stays separate.</span></article><article><small>USD still to collect</small><strong>${money(usd, "USD")}</strong><span>USD stays separate.</span></article></section><section class="accountant-package"><div><p class="kicker">Easy accountant handoff</p><h2>Everything in one download</h2><p>Finalized PDFs plus invoice and payment spreadsheets. Drafts stay private.</p></div><label>Period<select id="accountant-period"><option value="">All records</option>${accountantYears.map((year) => `<option value="${year}">${year}</option>`).join("")}</select></label><a class="primary large" id="accountant-package" href="/api/export/accountant-package">Download accountant package</a></section><section class="panel"><div class="panel-title"><div><p class="kicker">All records</p><h2>Invoices</h2></div><div class="actions"><label class="search">Search <input id="search" placeholder="Client or invoice number" /></label><a class="secondary" href="/api/export/invoices">Invoice CSV</a><a class="secondary" href="/api/export/payments">Payment CSV</a></div></div><div id="invoice-list">${invoiceCards(data.invoices)}</div></section>${paymentHistory()}`,
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
        ? `/api/export/accountant-package?year=${encodeURIComponent(year)}`
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
      const draftActions =
        invoice.state === "draft"
          ? `<button class="secondary" data-edit="${invoice.id}">Edit draft</button><button class="primary" data-issue="${invoice.id}">Finalize &amp; create PDF</button>`
          : `<a class="secondary" href="/api/pdf/${invoice.id}">Download PDF</a>`;
      const voidAction =
        invoice.state === "issued" && invoice.paymentsMinor === 0
          ? `<button class="danger-link" data-void="${invoice.id}">Void and make replacement</button>`
          : "";
      const payment =
        invoice.state === "issued" && invoice.balanceMinor > 0
          ? `<form class="payment-form" data-payment="${invoice.id}"><b>Record a payment</b><label>Amount<input name="amount" inputmode="decimal" placeholder="0.00" required /></label><label>How paid<select name="method"><option value="bank_transfer">Bank transfer</option><option value="paypal">PayPal</option><option value="other">Other</option></select></label><label>Reference<input name="reference" placeholder="Optional" /></label><button class="primary">Save payment</button></form>`
          : "";
      const checkout = invoice.stripeCheckout;
      const stripeControls =
        invoice.state === "issued" && invoice.balanceMinor > 0
          ? checkout?.status === "open"
            ? `<div class="stripe-box"><div><b>Stripe payment link ready</b><span>${checkout.livemode ? "LIVE payment" : "TEST payment"} · ${money(checkout.amountMinor, checkout.currency)}</span></div><div class="invoice-buttons"><a class="primary" href="${escapeHtml(checkout.url)}" target="_blank" rel="noreferrer">Open payment page</a><button class="secondary" data-copy-stripe="${escapeHtml(checkout.url)}">Copy link</button><button class="text-button" data-stripe-sync>Check payment status</button></div></div>`
            : data.stripe?.enabled
              ? `<div class="stripe-box"><div><b>Accept card payment</b><span>${data.stripe.mode === "test" ? "TEST MODE - no real charge" : "Creates a secure link for the exact balance"}</span></div><button class="primary" data-stripe-create="${invoice.id}">Create Stripe payment link</button></div>`
              : `<div class="stripe-box"><div><b>Stripe is not connected</b><span>Configure it once, then create exact payment links here.</span></div><button class="secondary" data-stripe-settings>Stripe setup</button></div>`
          : "";
      return `<article class="invoice-card"><div class="invoice-main"><div><span class="badge ${kind}">${label}</span><h3>${escapeHtml(invoice.invoiceNumber ?? "Unnumbered draft")}</h3><p>${escapeHtml(invoice.clientName)} · Due ${escapeHtml(invoice.dueDate)}</p></div><div class="amount"><strong>${money(invoice.totalMinor, invoice.currency)}</strong><span>${invoice.state === "issued" ? `${money(invoice.balanceMinor, invoice.currency)} remaining` : invoice.currency}</span></div></div><div class="invoice-buttons">${draftActions}${voidAction}</div>${stripeControls}${payment}${invoice.voidReason ? `<p class="void-note">Reason: ${escapeHtml(invoice.voidReason)}</p>` : ""}</article>`;
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
  return `<section class="panel"><div class="panel-title"><div><p class="kicker">Audit-friendly</p><h2>Payment history</h2></div><p>Gross customer payments. Fees are never guessed.</p></div><div class="payment-history">${data.payments.map((payment) => `<div class="${payment.status === "corrected" ? "corrected" : ""}"><b>${escapeHtml(payment.invoiceNumber)}</b><span>${escapeHtml(payment.paymentDate)}<small>${escapeHtml(payment.method.replace("_", " "))}</small></span><span>${escapeHtml(payment.reference || "No reference")}</span><b>${money(payment.amountMinor, payment.currency)}</b>${payment.status === "active" ? `<button class="text-button" data-correct="${payment.id}">Correct</button>` : `<em>Corrected</em>`}</div>`).join("")}</div></section>`;
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
        lines: invoice.lines.map(({ description, quantity, rateMinor }) => ({
          description,
          quantity,
          rateMinor,
        })),
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
            description: "Professional management services",
            quantity: "1",
            rateMinor: 0,
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
    `<section class="composer"><div class="composer-title"><div><p class="kicker">Draft - nothing is sent</p><h1>${editor.id ? "Edit your draft" : "Create an invoice"}</h1><p>Complete four short sections, then save and review.</p></div><div class="total-box"><small>Invoice total</small><strong id="live-total">${money(totals.total, editor.currency)}</strong></div></div><form id="invoice-form"><section class="form-section"><span class="number">1</span><div><h2>Who is this for?</h2><div class="grid"><label class="wide">Client<select name="clientId">${data.clients.map((client) => `<option value="${client.id}" ${client.id === editor.clientId ? "selected" : ""}>${escapeHtml(client.name)}${client.company ? ` - ${escapeHtml(client.company)}` : ""}</option>`).join("")}</select></label><label>Currency<select name="currency"><option ${editor.currency === "CAD" ? "selected" : ""}>CAD</option><option ${editor.currency === "USD" ? "selected" : ""}>USD</option></select><small>Never combined or converted.</small></label><label>Invoice date<input name="issueDate" type="date" value="${editor.issueDate}" required /></label><label>Payment due<input name="dueDate" type="date" value="${editor.dueDate}" required /></label></div></div></section><section class="form-section"><span class="number">2</span><div><h2>What are you billing for?</h2><div id="lines">${editor.lines.map((line, index) => `<div class="line-row"><label>Service description<input data-line="${index}" data-field="description" value="${escapeHtml(line.description)}" required /></label><label>Quantity<input data-line="${index}" data-field="quantity" value="${escapeHtml(line.quantity)}" inputmode="decimal" required /></label><label>Rate (${editor.currency})<input data-line="${index}" data-field="rate" value="${(line.rateMinor / 100).toFixed(2)}" inputmode="decimal" required /></label>${editor.lines.length > 1 ? `<button type="button" class="remove" data-remove-line="${index}" aria-label="Remove service">×</button>` : ""}</div>`).join("")}</div><button type="button" class="text-button" id="add-line">+ Add another service</button></div></section><section class="form-section"><span class="number">3</span><div><h2>Québec sales taxes</h2><p class="helper">GST is 5% and QST is 9.975%, both calculated on the pre-tax subtotal. Add them only if you are registered and this invoice is taxable.</p><div id="taxes">${editor.taxes.map((tax, index) => `<div class="tax-row"><label>Tax label<input data-tax="${index}" data-field="label" value="${escapeHtml(tax.label)}" required /></label><label>Rate %<input data-tax="${index}" data-field="rate" type="number" min="0" max="100" step="0.001" value="${(tax.rateThousandths / 1000).toFixed(3).replace(/\.?0+$/, "")}" required /></label><button type="button" class="remove" data-remove-tax="${index}" aria-label="Remove tax">×</button></div>`).join("")}</div><div class="tax-actions"><button type="button" class="primary" id="add-quebec-tax">+ Add Québec GST + QST</button><button type="button" class="text-button" id="add-tax">+ Custom tax</button></div></div></section><section class="form-section"><span class="number">4</span><div><h2>Final notes</h2><div class="grid"><label>Payment terms<textarea name="terms">${escapeHtml(editor.terms)}</textarea></label><label>Note on invoice<textarea name="notes">${escapeHtml(editor.notes)}</textarea></label></div></div></section><footer class="form-footer"><button type="button" class="secondary" id="cancel-editor">Cancel</button><span>This only saves a draft.</span><button class="primary large">Save draft →</button></footer></form></section>`,
  );
  bindEditor();
}

function bindEditor() {
  const form = document.querySelector("#invoice-form");
  form.addEventListener("input", (event) => {
    const target = event.target;
    if (target.dataset.line !== undefined) {
      const line = editor.lines[Number(target.dataset.line)];
      if (target.dataset.field === "rate")
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
    editor.lines.push({ description: "", quantity: "1", rateMinor: 0 });
    renderEditor();
  });
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
  shell(
    `<section class="simple"><p class="kicker">Saved address book</p><h1>Clients</h1><p>Add a client once, then choose them on future invoices.</p><div class="two-column"><form class="card-form" id="client-form"><h2>Add a client</h2><label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Company <small>optional</small><input name="company" /></label><label>Billing address<textarea name="address"></textarea></label><button class="primary">+ Save client</button></form><div class="client-list">${data.clients.map((client) => `<article><span class="avatar">${escapeHtml(client.name[0])}</span><div><h3>${escapeHtml(client.name)}</h3><p>${escapeHtml(client.company || "Individual")}</p><small>${escapeHtml(client.email)}</small></div></article>`).join("")}</div></div></section>`,
  );
  document.querySelector("#client-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(
      {
        action: "create-client",
        client: Object.fromEntries(new FormData(event.currentTarget)),
      },
      "Client saved and ready to invoice.",
    );
  });
}

function settingsScreen() {
  const s = data.settings;
  const stripe = data.stripe ?? { enabled: false, mode: "not configured" };
  const stripePanel = `<section class="stripe-settings"><div><p class="kicker">Card payments</p><h2>Stripe</h2><p>${stripe.enabled ? `<b>${stripe.mode === "live" ? "Live payments connected" : "Test mode connected"}.</b> Invoice Desk creates a hosted Checkout page for the exact unpaid balance and checks Stripe whenever the dashboard loads.` : `<b>Not connected yet.</b> When you have your Stripe test key, double-click <code>Configure Stripe.cmd</code> in the Invoice Desk folder. Your secret key is stored as a Windows user environment variable, never in this form or the database.`}</p>${stripe.error ? `<p class="stripe-error">Last Stripe check: ${escapeHtml(stripe.error)}</p>` : ""}</div><div class="stripe-status ${stripe.enabled ? "connected" : ""}">${stripe.enabled ? escapeHtml(stripe.mode.toUpperCase()) : "NOT CONNECTED"}</div></section>`;
  shell(
    `<section class="simple"><p class="kicker">Used on future invoices</p><h1>Business settings</h1><p>Issued invoices keep their original details when these settings change.</p><form class="card-form settings" id="settings-form"><div class="grid"><label>Business name<input name="name" value="${escapeHtml(s.name)}" required /></label><label>Billing email<input name="email" type="email" value="${escapeHtml(s.email)}" required /></label><label>Business address<textarea name="address">${escapeHtml(s.address)}</textarea></label><label>Logo URL <small>optional</small><input name="logoUrl" type="url" value="${escapeHtml(s.logoUrl)}" /></label><label>GST registration number <small>add later if registered</small><input name="gstNumber" value="${escapeHtml(s.gstNumber)}" placeholder="123456789RT0001" /></label><label>QST registration number <small>add later if registered</small><input name="qstNumber" value="${escapeHtml(s.qstNumber)}" placeholder="1234567890TQ0001" /></label><label>Accountant email <small>used in Stage 2</small><input name="accountantEmail" type="email" value="${escapeHtml(s.accountantEmail)}" /></label><label>PayPal fallback link <small>optional</small><input name="paypalFallbackUrl" type="url" value="${escapeHtml(s.paypalFallbackUrl)}" /></label><label>Payment instructions<textarea name="paymentInstructions">${escapeHtml(s.paymentInstructions)}</textarea></label><label>Invoice prefix<input name="invoicePrefix" value="${escapeHtml(s.invoicePrefix)}" pattern="[A-Z0-9-]+" required /></label><label>Next invoice number<input name="nextInvoiceNumber" type="number" min="1" value="${s.nextInvoiceNumber}" required /></label></div><button class="primary">Save settings</button></form>${stripePanel}</section>`,
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
}

function render() {
  if (!data) return loginScreen();
  if (view === "editor") return renderEditor();
  if (view === "clients") return clientsScreen();
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
