"use strict";

/* ------------------------------------------------------------------ *
 * Small IndexedDB helper — FileSystemDirectoryHandle can be stored in
 * IndexedDB (structured-clone), but NOT in chrome.storage.
 * ------------------------------------------------------------------ */
const DB_NAME = "stf-db";
const STORE = "handles";
const HANDLE_KEY = "baseFolder";

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

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */
const els = {
  tabCamera: document.getElementById("tab-camera"),
  tabSettings: document.getElementById("tab-settings"),
  viewCamera: document.getElementById("view-camera"),
  viewSettings: document.getElementById("view-settings"),
  subpath: document.getElementById("subpath"),
  prefix: document.getElementById("prefix"),
  url: document.getElementById("url"),
  description: document.getElementById("description"),
  miniPrompt: document.getElementById("mini-prompt"),
  includeNetwork: document.getElementById("include-network"),
  targetPreview: document.getElementById("target-preview"),
  take: document.getElementById("take"),
  cameraStatus: document.getElementById("camera-status"),
  baseDisplay: document.getElementById("base-display"),
  chooseFolder: document.getElementById("choose-folder"),
  forgetFolder: document.getElementById("forget-folder"),
  settingsStatus: document.getElementById("settings-status"),
};

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

/* ------------------------------------------------------------------ *
 * View switching
 * ------------------------------------------------------------------ */
function showView(name) {
  const camera = name === "camera";
  els.viewCamera.classList.toggle("hidden", !camera);
  els.viewSettings.classList.toggle("hidden", camera);
  els.tabCamera.classList.toggle("active", camera);
  els.tabSettings.classList.toggle("active", !camera);
}
els.tabCamera.addEventListener("click", () => showView("camera"));
els.tabSettings.addEventListener("click", () => showView("settings"));

/* ------------------------------------------------------------------ *
 * Path helpers
 * ------------------------------------------------------------------ */
function splitSubpath(sub) {
  return (sub || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
}

// Strip characters that aren't safe/clean in a filename.
function sanitizePrefix(p) {
  return (p || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Timestamped basename (no extension), e.g. "login-page-2026-07-15_10-00-05".
// Computed once per capture so the .png and .md sidecar always pair up.
function buildBasename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const prefix = sanitizePrefix(els.prefix.value);
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return prefix ? `${prefix}-${stamp}` : `screenshot-${stamp}`;
}

function timestampName() {
  return buildBasename() + ".png";
}

function hasMetadata() {
  return Boolean(els.description.value.trim() || els.miniPrompt.value.trim());
}

function updatePreview() {
  const base = els.baseDisplay.value || "<base folder>";
  const parts = splitSubpath(els.subpath.value);
  const joined = parts.length ? base + "/" + parts.join("/") : base;
  els.targetPreview.textContent =
    joined + "/" + timestampName() + (hasMetadata() ? "  (+ .md)" : "");
}

/* ------------------------------------------------------------------ *
 * Permission handling for a stored directory handle
 * ------------------------------------------------------------------ */
async function ensurePermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Capture + draw URL bar onto the image
 * ------------------------------------------------------------------ */
async function captureWithUrl(urlText) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const barH = 34;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height + barH;
  const ctx = canvas.getContext("2d");

  // URL bar
  ctx.fillStyle = "#202124";
  ctx.fillRect(0, 0, canvas.width, barH);
  ctx.fillStyle = "#e8eaed";
  ctx.font = "16px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textBaseline = "middle";

  const fullUrl = urlText || tab.url || "";
  let url = fullUrl;
  const maxW = canvas.width - 24;
  while (url && ctx.measureText(url).width > maxW) url = url.slice(0, -2);
  if (url !== fullUrl) url += "…";
  ctx.fillText(url, 12, barH / 2 + 1);

  // page below the bar
  ctx.drawImage(img, 0, barH);

  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  );
}

/* ------------------------------------------------------------------ *
 * Collect network activity from the active tab via the page's Resource
 * Timing API. This is what the DevTools waterfall is built on: every
 * request since the current page load, with URL / type / size / duration
 * and (modern Chrome) status code. No request/response bodies.
 * ------------------------------------------------------------------ */
async function collectNetworkData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return [];

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const toRow = (e, type) => ({
        url: e.name,
        type: type || e.initiatorType || "",
        status: typeof e.responseStatus === "number" ? e.responseStatus : null,
        size: e.transferSize || e.encodedBodySize || 0,
        ms: Math.round(e.duration),
        start: Math.round(e.startTime),
      });
      const rows = performance.getEntriesByType("resource").map((e) => toRow(e));
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav) rows.unshift(toRow(nav, "navigation"));
      return rows.sort((a, b) => a.start - b.start);
    },
  });
  return (results && results[0] && results[0].result) || [];
}

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
 * Build the Markdown sidecar Claude reads alongside the screenshot
 * ------------------------------------------------------------------ */
function buildMetadataMarkdown({ pngName, description, prompt, url, network }) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const captured =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;

  const title = (description || "Screenshot").split("\n")[0].slice(0, 80);
  const lines = [`# Issue: ${title}`, "", `![screenshot](${pngName})`, ""];
  if (description) lines.push(`**Description:** ${description}`, "");
  if (prompt) lines.push(`**Prompt:** ${prompt}`, "");
  if (url) lines.push(`**URL:** ${url}`);
  lines.push(`**Captured:** ${captured}`, "");
  lines.push(...networkMarkdown(network));
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Write a blob into base/<subpath>/file.png, creating subfolders
 * ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ *
 * Settings: choose / forget folder
 * ------------------------------------------------------------------ */
els.chooseFolder.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet(HANDLE_KEY, handle);
    await chrome.storage.local.set({ baseName: handle.name });
    els.baseDisplay.value = handle.name;
    updatePreview();
    setStatus(els.settingsStatus, `Base folder set: ${handle.name}`, "ok");
  } catch (e) {
    if (e && e.name === "AbortError") return; // user cancelled picker
    setStatus(els.settingsStatus, "Could not set folder: " + e.message, "err");
  }
});

els.forgetFolder.addEventListener("click", async () => {
  await idbDel(HANDLE_KEY);
  await chrome.storage.local.remove("baseName");
  els.baseDisplay.value = "";
  updatePreview();
  setStatus(els.settingsStatus, "Folder forgotten.", "info");
});

/* ------------------------------------------------------------------ *
 * Camera: take screenshot
 * ------------------------------------------------------------------ */
els.subpath.addEventListener("input", () => {
  updatePreview();
  chrome.storage.local.set({ lastSubpath: els.subpath.value });
});

els.prefix.addEventListener("input", () => {
  updatePreview();
  chrome.storage.local.set({ lastPrefix: els.prefix.value });
});

// Description / mini-prompt are per-issue: they update the preview but are
// intentionally NOT persisted, and are cleared after a successful capture.
els.description.addEventListener("input", updatePreview);
els.miniPrompt.addEventListener("input", updatePreview);

// The "include network data" choice is a remembered preference (default on).
els.includeNetwork.addEventListener("change", () => {
  chrome.storage.local.set({ includeNetwork: els.includeNetwork.checked });
});

els.take.addEventListener("click", async () => {
  els.take.disabled = true;
  setStatus(els.cameraStatus, "Capturing…", "info");
  try {
    const baseHandle = await idbGet(HANDLE_KEY);
    if (!baseHandle) {
      setStatus(
        els.cameraStatus,
        "No base folder set. Open ⚙️ Settings and choose one first.",
        "err"
      );
      showView("settings");
      return;
    }
    if (!(await ensurePermission(baseHandle))) {
      setStatus(
        els.cameraStatus,
        "Permission to write to the folder was denied.",
        "err"
      );
      return;
    }

    const url = els.url.value.trim();
    const blob = await captureWithUrl(url);
    const basename = buildBasename();
    const filename = basename + ".png";
    await writeInto(baseHandle, els.subpath.value, blob, filename);

    // Write the Claude-readable sidecar only when there's metadata to save.
    const description = els.description.value.trim();
    const prompt = els.miniPrompt.value.trim();
    let savedNote = filename;
    if (description || prompt) {
      // Network capture is best-effort — never let it block the save.
      let network = [];
      if (els.includeNetwork.checked) {
        try {
          network = await collectNetworkData();
        } catch (e) {
          network = [];
        }
      }

      const mdName = basename + ".md";
      const md = buildMetadataMarkdown({
        pngName: filename,
        description,
        prompt,
        url,
        network,
      });
      const mdBlob = new Blob([md], { type: "text/markdown" });
      await writeInto(baseHandle, els.subpath.value, mdBlob, mdName);
      savedNote = `${filename} + ${mdName}`;
      // Clear per-issue fields after a successful capture.
      els.description.value = "";
      els.miniPrompt.value = "";
      updatePreview();
    }

    const parts = splitSubpath(els.subpath.value);
    const where = (parts.length ? parts.join("/") + "/" : "") + savedNote;
    setStatus(els.cameraStatus, `Saved ✓  ${baseHandle.name}/${where}`, "ok");
  } catch (e) {
    setStatus(els.cameraStatus, "Failed: " + (e.message || e), "err");
  } finally {
    els.take.disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * Init — restore base-folder name and last subpath
 * ------------------------------------------------------------------ */
(async function init() {
  const { baseName, lastSubpath, lastPrefix, includeNetwork } =
    await chrome.storage.local.get([
      "baseName",
      "lastSubpath",
      "lastPrefix",
      "includeNetwork",
    ]);
  if (baseName) els.baseDisplay.value = baseName;
  if (lastSubpath) els.subpath.value = lastSubpath;
  if (lastPrefix) els.prefix.value = lastPrefix;
  // Default off when never set; otherwise honour the saved choice.
  els.includeNetwork.checked = includeNetwork === true;

  // Auto-detect the current tab's URL. Editable, and used for both the
  // baked-in URL bar and the sidecar. Not persisted — always reflects the
  // tab the popup was opened on.
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab && tab.url) els.url.value = tab.url;
  } catch (e) {
    /* leave the field blank if the tab can't be read */
  }

  updatePreview();
  showView("camera");
})();
