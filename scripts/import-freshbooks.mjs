import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  closeDatabase,
  dashboard,
  saveClient,
  saveService,
} from "../src/core.js";

function parseCsv(contents) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const [headers = [], ...values] = rows;
  return values
    .filter((fields) => fields.some((value) => value.trim()))
    .map((fields) =>
      Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""])),
    );
}

function findExport(folder, words) {
  const file = readdirSync(folder).find((name) =>
    words.every((word) => name.toLowerCase().includes(word)),
  );
  if (!file) throw new Error(`Could not find the ${words.join(" ")} export in ${folder}`);
  return path.join(folder, file);
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function dollars(value) {
  const clean = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean))
    throw new Error(`Could not read FreshBooks price: ${value}`);
  const [whole, fraction = ""] = clean.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

const folder = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(folder))
  throw new Error("Usage: node scripts/import-freshbooks.mjs <FreshBooks backup folder> [CAD|USD]");
const importCurrency = String(process.argv[3] ?? "CAD").toUpperCase();
if (!["CAD", "USD"].includes(importCurrency))
  throw new Error("Import currency must be CAD or USD");

const clientFile = await findExport(folder, ["clients", "export"]);
const itemFile = await findExport(folder, ["items", "export"]);
const clientRows = parseCsv(readFileSync(clientFile, "utf8").replace(/^\uFEFF/, ""));
const itemRows = parseCsv(readFileSync(itemFile, "utf8").replace(/^\uFEFF/, ""));

let state = dashboard();
let clientsCreated = 0;
let clientsUpdated = 0;
let servicesCreated = 0;
let servicesUpdated = 0;
let needsReview = 0;

for (const [index, row] of clientRows.entries()) {
  const person = [row["First Name"], row["Last Name"]].filter(Boolean).join(" ").trim();
  const name = person || row.Organization.trim() || row.Email.trim() || `Needs review – FreshBooks row ${index + 2}`;
  const missingIdentity = !person && !row.Organization.trim();
  const address = [
    row["Address Line 1"],
    row["Address Line 2"],
    [row.City, row["Province/State"], row["Postal Code"]].filter(Boolean).join(" "),
    row.Country,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const notes = [
    row.Notes.trim(),
    missingIdentity ? "Needs review: FreshBooks did not provide a person or organization name." : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (missingIdentity || !row.Email.trim()) needsReview += 1;
  const byEmail = row.Email.trim()
    ? state.clients.find((client) => normalized(client.email) === normalized(row.Email))
    : null;
  const byName = state.clients.find(
    (client) =>
      normalized(client.name) === normalized(name) &&
      normalized(client.company) === normalized(row.Organization),
  );
  const existing = byEmail ?? byName;
  saveClient(
    {
      name,
      email: row.Email.trim(),
      company: row.Organization.trim(),
      phone: row.Phone.trim(),
      address,
      notes,
      sourceKey: `freshbooks-client:${index + 2}`,
    },
    existing?.id,
  );
  if (existing) clientsUpdated += 1;
  else clientsCreated += 1;
  state = dashboard();
}

for (const [index, row] of itemRows.entries()) {
  const name = row.Name.trim();
  if (!name) continue;
  const existing = state.services.find(
    (service) => normalized(service.name) === normalized(name) && service.currency === importCurrency,
  );
  saveService(
    {
      name,
      description: name,
      category: "Services",
      currency: importCurrency,
      rateMinor: dollars(row.Rate),
      sourceKey: `freshbooks-item:${index + 2}`,
    },
    existing?.id,
  );
  if (existing) servicesUpdated += 1;
  else servicesCreated += 1;
  state = dashboard();
}

closeDatabase();

console.log(
  JSON.stringify(
    {
      clients: { created: clientsCreated, updated: clientsUpdated, needsReview },
      services: { created: servicesCreated, updated: servicesUpdated },
      currency: importCurrency,
    },
    null,
    2,
  ),
);
