import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  contentHash,
  validateRecord,
} from "./contracts.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(moduleDir, "migrations");

function recordContentHash(record) {
  const value = structuredClone(record);
  delete value.contentHash;
  return contentHash(value);
}

function assertDeclaredHash(record) {
  const actual = recordContentHash(record);
  if (record.contentHash !== actual) {
    throw new Error(`contentHash does not match canonical record content: expected ${actual}`);
  }
}

function safeId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`unsafe record id: ${id}`);
  return id;
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  return {
    commit() {
      fs.renameSync(temp, file);
    },
    rollback() {
      fs.rmSync(temp, { force: true });
    },
  };
}

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter(name => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function openDomainStore({
  dbPath,
  exportRoot,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!dbPath || !exportRoot) throw new Error("dbPath and exportRoot are required");
  const resolvedDb = path.resolve(dbPath);
  const resolvedExport = path.resolve(exportRoot);
  fs.mkdirSync(path.dirname(resolvedDb), { recursive: true });
  fs.mkdirSync(resolvedExport, { recursive: true });
  const db = new DatabaseSync(resolvedDb);
  let closed = false;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  function migrate() {
    const report = [];
    for (const name of migrationFiles()) {
      const version = Number(name.match(/^(\d+)/)[1]);
      const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
      const checksum = crypto.createHash("sha256").update(sql, "utf8").digest("hex");
      const existing = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(version);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`migration checksum mismatch: ${name}`);
        report.push({ version, applied: false });
        continue;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(sql);
        db.prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
        ).run(version, name, checksum, clock());
        db.exec("COMMIT");
        report.push({ version, applied: true });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return report;
  }

  function exportPath(kind, id) {
    return path.join(resolvedExport, safeId(kind), `${safeId(id)}.json`);
  }

  function put(kind, record, expectedHash) {
    validateRecord(kind, record);
    assertDeclaredHash(record);
    const existing = db.prepare(
      "SELECT content_hash FROM records WHERE kind = ? AND id = ?"
    ).get(kind, record.id);
    if (existing && !expectedHash) throw new Error("record already exists; expected hash is required for update");
    if (expectedHash && existing?.content_hash !== expectedHash) {
      throw new Error("expected hash does not match stored record");
    }
    if (expectedHash && !existing) throw new Error("expected hash supplied for missing record");

    const file = exportPath(kind, record.id);
    const previousExport = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const writer = writeFileAtomic(file, `${canonicalJson(record)}\n`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO records(kind, id, status, namespace, content_hash, json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, id) DO UPDATE SET
          status = excluded.status,
          namespace = excluded.namespace,
          content_hash = excluded.content_hash,
          json = excluded.json,
          updated_at = excluded.updated_at
      `).run(
        kind,
        record.id,
        record.status,
        record.namespace || null,
        record.contentHash,
        canonicalJson(record),
        record.createdAt,
        clock()
      );
      writer.commit();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      writer.rollback();
      if (previousExport === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, previousExport, "utf8");
      throw error;
    }
    return record;
  }

  function get(kind, id) {
    const row = db.prepare("SELECT json FROM records WHERE kind = ? AND id = ?").get(kind, id);
    return row ? JSON.parse(row.json) : null;
  }

  function list(kind, { status, namespace } = {}) {
    const conditions = ["kind = ?"];
    const values = [kind];
    if (status) {
      conditions.push("status = ?");
      values.push(status);
    }
    if (namespace) {
      conditions.push("namespace = ?");
      values.push(namespace);
    }
    return db.prepare(
      `SELECT json FROM records WHERE ${conditions.join(" AND ")} ORDER BY id`
    ).all(...values).map(row => JSON.parse(row.json));
  }

  function appendEvent(event) {
    validateRecord("production-event", event);
    assertDeclaredHash(event);
    db.prepare(`
      INSERT INTO events(id, subject_id, action, created_at, content_hash, json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.subjectId, event.action, event.createdAt, event.contentHash, canonicalJson(event));
    return event;
  }

  function eventsFor(subjectId) {
    return db.prepare(
      "SELECT json FROM events WHERE subject_id = ? ORDER BY created_at, id"
    ).all(subjectId).map(row => JSON.parse(row.json));
  }

  function exportRecord(kind, id) {
    const record = get(kind, id);
    if (!record) return null;
    const file = exportPath(kind, id);
    const writer = writeFileAtomic(file, `${canonicalJson(record)}\n`);
    writer.commit();
    return file;
  }

  function close() {
    if (closed) return;
    db.close();
    closed = true;
  }

  migrate();

  return {
    db,
    dbPath: resolvedDb,
    exportRoot: resolvedExport,
    migrate,
    put,
    get,
    list,
    appendEvent,
    eventsFor,
    exportRecord,
    close,
  };
}
