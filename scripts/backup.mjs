import { backup, DatabaseSync } from "node:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const command = process.argv[2];
const supplied = process.argv[3];
const dataRoot = process.env.INVOICE_DESK_DATA_ROOT
  ? path.resolve(process.env.INVOICE_DESK_DATA_ROOT)
  : path.resolve("data");

function inspect(root) {
  const file = path.join(root, "invoice-desk.sqlite");
  if (!existsSync(file))
    throw new Error(`No Invoice Desk database found at ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const invoices = Number(
    db.prepare("SELECT COUNT(*) count FROM invoices").get().count,
  );
  const issued = Number(
    db
      .prepare("SELECT COUNT(*) count FROM invoices WHERE state != 'draft'")
      .get().count,
  );
  const pdfs = db
    .prepare("SELECT pdf_filename FROM invoices WHERE pdf_filename IS NOT NULL")
    .all()
    .map((row) => row.pdf_filename);
  db.close();
  const missing = pdfs.filter(
    (fileName) => !existsSync(path.join(root, "pdfs", fileName)),
  );
  if (integrity !== "ok" || missing.length)
    throw new Error(
      `Validation failed: integrity=${integrity}, missing PDFs=${missing.length}`,
    );
  return { integrity, invoices, issued, pdfs: pdfs.length };
}

async function createBackup(source, destination) {
  const file = path.join(source, "invoice-desk.sqlite");
  if (!existsSync(file))
    throw new Error(`No Invoice Desk database found at ${file}`);
  if (existsSync(destination))
    throw new Error(`Backup already exists: ${destination}`);
  mkdirSync(destination, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA wal_checkpoint(FULL)");
  await backup(db, path.join(destination, "invoice-desk.sqlite"));
  db.close();
  if (existsSync(path.join(source, "pdfs")))
    cpSync(path.join(source, "pdfs"), path.join(destination, "pdfs"), {
      recursive: true,
    });
  const summary = inspect(destination);
  writeFileSync(
    path.join(destination, "backup-manifest.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), summary }, null, 2),
  );
  return summary;
}

function restoreBackup(source, destination) {
  if (!existsSync(path.join(source, "backup-manifest.json")))
    throw new Error("This folder is not an Invoice Desk backup");
  if (existsSync(destination) && readdirSync(destination).length)
    throw new Error(`Restore destination must be empty: ${destination}`);
  mkdirSync(destination, { recursive: true });
  cpSync(
    path.join(source, "invoice-desk.sqlite"),
    path.join(destination, "invoice-desk.sqlite"),
  );
  if (existsSync(path.join(source, "pdfs")))
    cpSync(path.join(source, "pdfs"), path.join(destination, "pdfs"), {
      recursive: true,
    });
  return inspect(destination);
}

if (command === "backup") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = supplied
    ? path.resolve(supplied)
    : path.resolve("backups", `invoice-desk-${stamp}`);
  console.log(
    JSON.stringify(
      { destination, summary: await createBackup(dataRoot, destination) },
      null,
      2,
    ),
  );
} else if (command === "restore") {
  if (!supplied)
    throw new Error(
      "Usage: npm run restore -- <backup-folder> [empty-destination]",
    );
  const destination = process.argv[4]
    ? path.resolve(process.argv[4])
    : dataRoot;
  console.log(
    JSON.stringify(
      {
        destination,
        summary: restoreBackup(path.resolve(supplied), destination),
      },
      null,
      2,
    ),
  );
} else if (command === "smoke") {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "invoice-desk-backup-"));
  try {
    const before = inspect(dataRoot);
    await createBackup(dataRoot, path.join(temporary, "backup"));
    const after = restoreBackup(
      path.join(temporary, "backup"),
      path.join(temporary, "restore"),
    );
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Restored counts do not match");
    console.log(
      JSON.stringify({ ok: true, source: before, restored: after }, null, 2),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else throw new Error("Use backup, restore, or smoke");
