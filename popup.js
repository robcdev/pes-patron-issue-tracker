"use strict";

/* Shared helpers (idb*, splitSubpath, ensurePermission, nowStamp,
 * buildMetadataMarkdown, …) come from lib.js, loaded first. */

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */
const els = {
  tabCamera: document.getElementById("tab-camera"),
  tabEdit: document.getElementById("tab-edit"),
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
  regionPreview: document.getElementById("region-preview"),
  regionThumb: document.getElementById("region-thumb"),
  saveArea: document.getElementById("save-area"),
  discardRegion: document.getElementById("discard-region"),
  take: document.getElementById("take"),
  selectArea: document.getElementById("select-area"),
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
 * View switching (camera / settings). The ✏️ button opens the
 * references manager in its own browser tab instead of a view.
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

els.tabEdit.addEventListener("click", () => {
  // Pass the current subfolder so the page opens on the same location.
  const sub = encodeURIComponent(els.subpath.value || "");
  chrome.tabs.create({
    url: chrome.runtime.getURL("references.html") + "?sub=" + sub,
  });
});

/* ------------------------------------------------------------------ *
 * Filename helpers (sanitizePrefix / makeBasename live in lib.js)
 * ------------------------------------------------------------------ */
function timestampName() {
  return makeBasename(els.prefix.value) + ".png";
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
 * Capture the raw visible viewport (no URL bar — that's baked on at save
 * time, so the URL field stays editable until then).
 * ------------------------------------------------------------------ */
async function captureViewport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  return (await fetch(dataUrl)).blob();
}

/* ------------------------------------------------------------------ *
 * Collect network activity from the active tab via Resource Timing.
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
 * Camera: field listeners + take screenshot
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

// The "include network data" choice is a remembered preference (default off).
els.includeNetwork.addEventListener("change", () => {
  chrome.storage.local.set({ includeNetwork: els.includeNetwork.checked });
});

// The pending (captured-but-unsaved) screenshot: its blob, preview URL, the
// network data captured with it, and where it came from ("area" | "full").
let pendingRegionBlob = null;
let regionThumbUrl = null;
let pendingNetwork = [];
let pendingSource = null;

// Show the preview + Save button whenever a shot is pending. "Take full page"
// and "Select area…" are always available (they replace the pending shot);
// the selector reads "Retake area" only after an area selection.
function setMode() {
  const pending = Boolean(pendingRegionBlob);
  els.selectArea.textContent = pendingSource === "area" ? "Retake area" : "Select area…";
  els.regionPreview.classList.toggle("hidden", !pending);
}

async function writeShot(baseHandle, blob, network) {
  const url = els.url.value.trim();
  const basename = makeBasename(els.prefix.value);
  const filename = basename + ".png";
  await writeInto(baseHandle, els.subpath.value, blob, filename);

  // Write the Claude-readable sidecar only when there's metadata to save.
  const description = els.description.value.trim();
  const prompt = els.miniPrompt.value.trim();
  let savedNote = filename;
  if (description || prompt) {
    const mdName = basename + ".md";
    const md = buildMetadataMarkdown({
      pngName: filename,
      description,
      prompt,
      url,
      network: network || [],
    });
    await writeInto(
      baseHandle,
      els.subpath.value,
      new Blob([md], { type: "text/markdown" }),
      mdName
    );
    savedNote = `${filename} + ${mdName}`;
  }

  const parts = splitSubpath(els.subpath.value);
  const where = (parts.length ? parts.join("/") + "/" : "") + savedNote;
  return { baseName: baseHandle.name, where };
}

// Make `blob` the pending screenshot: show it in the preview and drop any
// previously persisted region. Nothing is written until Save.
async function setPending(blob, network, source) {
  try {
    await idbDel(PENDING_KEY);
  } catch (e) {
    /* ignore */
  }
  await chrome.storage.local.remove("pendingFields");
  chrome.runtime.sendMessage({ type: "stf-clear-badge" }).catch(() => {});
  if (regionThumbUrl) URL.revokeObjectURL(regionThumbUrl);
  pendingRegionBlob = blob;
  pendingNetwork = network || [];
  pendingSource = source;
  regionThumbUrl = URL.createObjectURL(blob);
  els.regionThumb.src = regionThumbUrl;
  setMode();
  updatePreview();
}

// Capture the whole viewport into the preview (does NOT save).
async function captureFullPage() {
  const blob = await captureViewport();
  let network = [];
  if (els.includeNetwork.checked) {
    try {
      network = await collectNetworkData();
    } catch (e) {
      network = [];
    }
  }
  await setPending(blob, network, "full");
  setStatus(els.cameraStatus, "Full page captured — review and click Save.", "info");
}

async function saveArea() {
  const baseHandle = await idbGet(HANDLE_KEY);
  if (!baseHandle) {
    setStatus(els.cameraStatus, "No base folder set. Open ⚙️ Settings first.", "err");
    showView("settings");
    return;
  }
  if (!(await ensurePermission(baseHandle))) {
    setStatus(els.cameraStatus, "Permission to write to the folder was denied.", "err");
    return;
  }

  // Bake the URL bar onto the cropped region (same look as full-page shots).
  const img = new Image();
  img.src = regionThumbUrl;
  await img.decode();
  const barH = 34;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height + barH;
  const ctx = canvas.getContext("2d");
  paintUrlBar(ctx, canvas.width, barH, els.url.value.trim());
  ctx.drawImage(img, 0, barH);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));

  const { baseName, where } = await writeShot(baseHandle, blob, pendingNetwork);
  await clearPendingRegion();
  els.description.value = "";
  els.miniPrompt.value = "";
  updatePreview();
  setStatus(els.cameraStatus, `Saved ✓  ${baseName}/${where}`, "ok");
}

async function clearPendingRegion() {
  try {
    await idbDel(PENDING_KEY);
  } catch (e) {
    /* ignore */
  }
  await chrome.storage.local.remove("pendingFields");
  chrome.runtime.sendMessage({ type: "stf-clear-badge" }).catch(() => {});
  if (regionThumbUrl) URL.revokeObjectURL(regionThumbUrl);
  regionThumbUrl = null;
  pendingRegionBlob = null;
  pendingNetwork = [];
  pendingSource = null;
  setMode();
}

els.take.addEventListener("click", async () => {
  els.take.disabled = true;
  setStatus(els.cameraStatus, "Capturing…", "info");
  try {
    await captureFullPage();
  } catch (e) {
    setStatus(els.cameraStatus, "Failed: " + (e.message || e), "err");
  } finally {
    els.take.disabled = false;
  }
});

els.saveArea.addEventListener("click", async () => {
  els.saveArea.disabled = true;
  setStatus(els.cameraStatus, "Saving…", "info");
  try {
    await saveArea();
  } catch (e) {
    setStatus(els.cameraStatus, "Failed: " + (e.message || e), "err");
  } finally {
    els.saveArea.disabled = false;
  }
});

els.discardRegion.addEventListener("click", async () => {
  await clearPendingRegion();
  updatePreview();
  setStatus(els.cameraStatus, "Discarded.", "info");
});

/* ------------------------------------------------------------------ *
 * Select area: persist the fields, inject the live selection overlay
 * into the active tab, and close. The overlay + background worker capture
 * the region; the confirmed result is picked up when the popup reopens.
 * ------------------------------------------------------------------ */
els.selectArea.addEventListener("click", async () => {
  els.selectArea.disabled = true;
  setStatus(els.cameraStatus, "Opening selector…", "info");
  try {
    const baseHandle = await idbGet(HANDLE_KEY);
    if (!baseHandle) {
      setStatus(els.cameraStatus, "No base folder set. Open ⚙️ Settings first.", "err");
      showView("settings");
      els.selectArea.disabled = false;
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error("No active tab.");
    if (/^(chrome|edge|about|chrome-extension|https:\/\/chrome\.google\.com\/webstore)/.test(tab.url || "")) {
      setStatus(els.cameraStatus, "Can't select on this page (browser/internal page).", "err");
      els.selectArea.disabled = false;
      return;
    }

    // Best-effort network capture now (page is active), carried to save time.
    let network = [];
    if (els.includeNetwork.checked) {
      try {
        network = await collectNetworkData();
      } catch (e) {
        network = [];
      }
    }

    // Persist all fields so they're restored when the popup reopens.
    await chrome.storage.local.set({
      pendingFields: {
        subpath: els.subpath.value,
        prefix: els.prefix.value,
        url: els.url.value.trim(),
        description: els.description.value.trim(),
        prompt: els.miniPrompt.value.trim(),
        includeNetwork: els.includeNetwork.checked,
        network,
      },
    });
    // Start fresh: drop any previously confirmed region.
    await idbDel(PENDING_KEY);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["overlay.js"],
    });
    window.close();
  } catch (e) {
    setStatus(els.cameraStatus, "Failed: " + (e.message || e), "err");
    els.selectArea.disabled = false;
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

  // If we're returning from a "Select area" round trip, restore every field
  // exactly as it was and pick up the confirmed region (if any).
  const { pendingFields } = await chrome.storage.local.get(["pendingFields"]);
  const pendingRegion = await idbGet(PENDING_KEY);

  if (pendingFields) {
    els.subpath.value = pendingFields.subpath || "";
    els.prefix.value = pendingFields.prefix || "";
    els.url.value = pendingFields.url || "";
    els.description.value = pendingFields.description || "";
    els.miniPrompt.value = pendingFields.prompt || "";
    els.includeNetwork.checked = pendingFields.includeNetwork === true;
    pendingNetwork = pendingFields.network || [];
  } else {
    // Auto-detect the current tab's URL (editable). Only when not restoring.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) els.url.value = tab.url;
    } catch (e) {
      /* leave the field blank if the tab can't be read */
    }
  }

  if (pendingRegion && pendingRegion.blob) {
    pendingRegionBlob = pendingRegion.blob;
    pendingSource = "area";
    regionThumbUrl = URL.createObjectURL(pendingRegion.blob);
    els.regionThumb.src = regionThumbUrl;
  } else if (pendingFields) {
    // Fields were saved but no region confirmed (cancelled/aborted) — tidy up.
    await chrome.storage.local.remove("pendingFields");
    chrome.runtime.sendMessage({ type: "stf-clear-badge" }).catch(() => {});
  }

  setMode();
  updatePreview();
  showView("camera");
})();
