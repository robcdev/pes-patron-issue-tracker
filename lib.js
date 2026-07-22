"use strict";

/* ------------------------------------------------------------------ *
 * Shared helpers used by both the popup and the references page.
 * Loaded as a plain script before each page's own script, so these
 * become globals.
 * ------------------------------------------------------------------ */

/* ---- IndexedDB (stores the FileSystemDirectoryHandle) ---- */
const DB_NAME = "stf-db";
const STORE = "handles";
const HANDLE_KEY = "baseFolder";
// A region capture is handed from the popup to capture.html via this key.
const PENDING_KEY = "pendingCapture";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---- Paths ---- */
function splitSubpath(sub) {
  return (sub || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
}

/* ---- Directory-handle permission ---- */
async function ensurePermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

// Walk base → subpath and return the directory handle (no creation).
async function getSubDir(baseHandle, subpath) {
  let dir = baseHandle;
  for (const part of splitSubpath(subpath)) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  return dir;
}

// Write a blob into base/<subpath>/filename, creating subfolders as needed.
async function writeInto(baseHandle, subpath, blob, filename) {
  let dir = baseHandle;
  for (const part of splitSubpath(subpath)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/* ---- Filenames ---- */
function sanitizePrefix(p) {
  return (p || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Timestamped basename (no extension). Computed once per capture so the
// .png and its .md sidecar always pair up.
function makeBasename(prefixValue) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const prefix = sanitizePrefix(prefixValue);
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return prefix ? `${prefix}-${stamp}` : `screenshot-${stamp}`;
}

/* ---- Draw the dark URL bar across the top of a canvas ---- */
function paintUrlBar(ctx, width, barH, urlText) {
  ctx.fillStyle = "#202124";
  ctx.fillRect(0, 0, width, barH);
  ctx.fillStyle = "#e8eaed";
  ctx.font = "16px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textBaseline = "middle";
  const full = urlText || "";
  let url = full;
  const maxW = width - 24;
  while (url && ctx.measureText(url).width > maxW) url = url.slice(0, -2);
  if (url !== full) url += "…";
  ctx.fillText(url, 12, barH / 2 + 1);
}

/* ---- Timestamp ---- */
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/* ---- Network table rendering ---- */
function fmtBytes(n) {
  if (!n) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

// Keep the sidecar from ballooning on request-heavy pages.
const MAX_NETWORK_ROWS = 200;

function networkMarkdown(network) {
  if (!network || !network.length) return [];
  const rows = network.slice(0, MAX_NETWORK_ROWS);
  const failed = network.filter((r) => r.status && r.status >= 400).length;

  const head = `## Network (${network.length} request${
    network.length === 1 ? "" : "s"
  } via Resource Timing${failed ? `, ${failed} failed` : ""})`;

  const lines = [
    head,
    "",
    "| status | type | size | ms | url |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const url = String(r.url || "").replace(/\|/g, "%7C");
    lines.push(
      `| ${r.status ?? "—"} | ${r.type || "—"} | ${fmtBytes(r.size)} | ${
        r.ms
      } | ${url} |`
    );
  }
  if (network.length > rows.length) {
    lines.push("", `_…and ${network.length - rows.length} more request(s)._`);
  }
  lines.push("");
  return lines;
}

/* ------------------------------------------------------------------ *
 * Build the Markdown sidecar Claude reads alongside the screenshot.
 * On a fresh capture, pass `network` (array) to render a table.
 * On edit, pass `captured` and `networkMd` (the preserved section) so
 * that data survives untouched.
 * ------------------------------------------------------------------ */
function buildMetadataMarkdown({
  pngName,
  description,
  prompt,
  url,
  captured,
  network,
  networkMd,
}) {
  const cap = captured || nowStamp();
  const title = (description || "Screenshot").split("\n")[0].slice(0, 80);
  const lines = [`# Issue: ${title}`, "", `![screenshot](${pngName})`, ""];
  if (description) lines.push(`**Description:** ${description}`, "");
  if (prompt) lines.push(`**Prompt:** ${prompt}`, "");
  if (url) lines.push(`**URL:** ${url}`);
  lines.push(`**Captured:** ${cap}`, "");
  if (networkMd) lines.push(networkMd.trim(), "");
  else lines.push(...networkMarkdown(network));

  // Machine-readable block for round-trip editing — invisible in rendered
  // Markdown, authoritative when the editor re-opens this sidecar.
  const meta = { v: 1, description, prompt, url, captured: cap };
  lines.push(`<!-- stf-meta: ${JSON.stringify(meta)} -->`, "");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Parse a sidecar back into editable fields. Prefers the stf-meta block;
 * falls back to regex for sidecars written before that block existed.
 * The rendered `## Network` section is preserved verbatim.
 * ------------------------------------------------------------------ */
function parseSidecar(md) {
  const out = { description: "", prompt: "", url: "", captured: "", networkMd: "" };
  if (!md) return out;

  const netIdx = md.indexOf("\n## Network");
  if (netIdx !== -1) {
    let net = md.slice(netIdx).trim();
    const mIdx = net.indexOf("<!-- stf-meta:");
    if (mIdx !== -1) net = net.slice(0, mIdx).trim();
    out.networkMd = net;
  }

  const meta = md.match(/<!-- stf-meta:\s*([\s\S]*?)\s*-->/);
  if (meta) {
    try {
      const j = JSON.parse(meta[1]);
      out.description = j.description || "";
      out.prompt = j.prompt || "";
      out.url = j.url || "";
      out.captured = j.captured || "";
      return out;
    } catch (e) {
      /* fall through to regex parsing */
    }
  }

  const oneLine = (label) => {
    const m = md.match(new RegExp(`\\*\\*${label}:\\*\\* ?(.*)`));
    return m ? m[1].trim() : "";
  };
  const block = (label) => {
    const m = md.match(
      new RegExp(`\\*\\*${label}:\\*\\* ?([\\s\\S]*?)(?=\\n\\n|\\n## |$)`)
    );
    return m ? m[1].trim() : "";
  };
  out.url = oneLine("URL");
  out.captured = oneLine("Captured");
  out.description = block("Description");
  out.prompt = block("Prompt");
  return out;
}
