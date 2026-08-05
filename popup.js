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
  committedList: document.getElementById("committed-list"),
  regionPreview: document.getElementById("region-preview"),
  regionThumb: document.getElementById("region-thumb"),
  addScreenshot: document.getElementById("add-screenshot"),
  discardRegion: document.getElementById("discard-region"),
  saveAll: document.getElementById("save-all"),
  clearAll: document.getElementById("clear-all"),
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

function hasMetadata() {
  return Boolean(els.description.value.trim() || els.miniPrompt.value.trim());
}

function updatePreview() {
  const base = els.baseDisplay.value || "<base folder>";
  const parts = splitSubpath(els.subpath.value);
  const joined = parts.length ? base + "/" + parts.join("/") : base;
  const basename = makeBasename(els.prefix.value);
  const total = committedShots.length + (pendingRegionBlob ? 1 : 0);
  const fileDesc =
    total > 1
      ? `${basename}-1.png … ${basename}-${total}.png  (${total} screenshots)`
      : basename + ".png";
  els.targetPreview.textContent =
    joined + "/" + fileDesc + (hasMetadata() ? "  (+ .md)" : "");
}

/* ------------------------------------------------------------------ *
 * Capture the raw visible viewport (no URL bar — that's baked on at save
 * time, so the URL field stays editable until then). Also returns the
 * tab's actual URL at this moment — the shot's "source" — independent of
 * the shared/editable URL field.
 * ------------------------------------------------------------------ */
async function captureViewport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  const blob = await (await fetch(dataUrl)).blob();
  return { blob, sourceUrl: tab.url || "" };
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

// URL / description / mini-prompt are persisted as a "draft" on every
// keystroke so switching tabs (which closes this popup) never loses what
// was typed. The draft is cleared only after a successful Save.
function saveDraftFields() {
  chrome.storage.local.set({
    draftFields: {
      url: els.url.value,
      description: els.description.value,
      prompt: els.miniPrompt.value,
    },
  });
}
els.url.addEventListener("input", saveDraftFields);
els.description.addEventListener("input", () => {
  updatePreview();
  saveDraftFields();
});
els.miniPrompt.addEventListener("input", () => {
  updatePreview();
  saveDraftFields();
});

// The "include network data" choice is a remembered preference (default off).
els.includeNetwork.addEventListener("change", () => {
  chrome.storage.local.set({ includeNetwork: els.includeNetwork.checked });
});

// The current draft: a captured-but-uncommitted screenshot (its blob,
// preview URL, network rows, where it came from — "area" | "full" — and
// the actual tab URL it was captured from, auto-detected, distinct from
// the shared/editable URL field). "Take full page" / "Select area…"
// replace this slot; "Add screenshot" locks it into `committedShots` below
// and clears the slot.
let pendingRegionBlob = null;
let regionThumbUrl = null;
let pendingNetwork = [];
let pendingSource = null;
let pendingSourceUrl = "";

// Screenshots already locked in via "Add screenshot", awaiting Save.
// Each entry: { blob, source, network, sourceUrl, thumbUrl }. Persisted
// (minus thumbUrl) so the list survives the popup closing on a tab switch.
let committedShots = [];

// Show the draft preview whenever one is pending. "Take full page" and
// "Select area…" are always available (they replace the draft); the
// selector reads "Retake area" only after an area selection. Save/Clear
// are enabled whenever there's anything (draft or committed) to save.
function setMode() {
  const pending = Boolean(pendingRegionBlob);
  els.selectArea.textContent = pendingSource === "area" ? "Retake area" : "Select area…";
  els.regionPreview.classList.toggle("hidden", !pending);
  const hasAny = pending || committedShots.length > 0;
  els.saveAll.disabled = !hasAny;
  els.clearAll.classList.toggle("hidden", !hasAny);
}

function renderCommittedList() {
  els.committedList.innerHTML = "";
  els.committedList.classList.toggle("hidden", committedShots.length === 0);
  committedShots.forEach((shot, i) => {
    const row = document.createElement("div");
    row.className = "committed-item";

    const img = document.createElement("img");
    img.src = shot.thumbUrl;
    img.alt = `screenshot ${i + 1}`;

    const label = document.createElement("span");
    label.className = "committed-label";
    label.textContent = `Screenshot ${i + 1}`;

    const remove = document.createElement("button");
    remove.className = "link-btn";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeCommitted(i));

    row.append(img, label, remove);
    els.committedList.append(row);
  });
}

// Persist committedShots (minus in-memory-only thumbUrl) to IDB.
async function persistCommitted() {
  if (committedShots.length) {
    await idbSet(
      COMMITTED_KEY,
      committedShots.map(({ blob, source, network, sourceUrl }) => ({
        blob,
        source,
        network,
        sourceUrl,
      }))
    );
  } else {
    try {
      await idbDel(COMMITTED_KEY);
    } catch (e) {
      /* ignore */
    }
  }
}

async function removeCommitted(i) {
  const [removed] = committedShots.splice(i, 1);
  if (removed && removed.thumbUrl) URL.revokeObjectURL(removed.thumbUrl);
  await persistCommitted();
  renderCommittedList();
  setMode();
  updatePreview();
}

// Lock the current draft into the committed list and clear the slot so
// the next "Take full page"/"Select area…" starts a fresh capture.
async function commitDraft() {
  if (!pendingRegionBlob) return;
  committedShots.push({
    blob: pendingRegionBlob,
    source: pendingSource,
    network: pendingNetwork,
    sourceUrl: pendingSourceUrl,
    thumbUrl: regionThumbUrl, // ownership moves here — don't revoke below
  });
  await persistCommitted();

  try {
    await idbDel(PENDING_KEY);
  } catch (e) {
    /* ignore */
  }
  await chrome.storage.local.remove("pendingNetwork");
  chrome.runtime.sendMessage({ type: "stf-clear-badge" }).catch(() => {});
  pendingRegionBlob = null;
  pendingNetwork = [];
  pendingSource = null;
  pendingSourceUrl = "";
  regionThumbUrl = null; // now owned by the committed entry above

  renderCommittedList();
  setMode();
  updatePreview();
  setStatus(els.cameraStatus, "Added. Capture another or click Save.", "info");
}

// Make `blob` the current draft: show it in the preview and persist it
// (IDB for the blob, storage for its network rows) so it survives the popup
// closing when a tab switch steals focus. Nothing is written until Save.
async function setPending(blob, network, source, sourceUrl) {
  await idbSet(PENDING_KEY, { blob, source, sourceUrl: sourceUrl || "" });
  await chrome.storage.local.set({ pendingNetwork: network || [] });
  if (regionThumbUrl) URL.revokeObjectURL(regionThumbUrl);
  pendingRegionBlob = blob;
  pendingNetwork = network || [];
  pendingSource = source;
  pendingSourceUrl = sourceUrl || "";
  regionThumbUrl = URL.createObjectURL(blob);
  els.regionThumb.src = regionThumbUrl;
  setMode();
  updatePreview();
}

// Capture the whole viewport into the draft preview (does NOT save).
async function captureFullPage() {
  const { blob, sourceUrl } = await captureViewport();
  let network = [];
  if (els.includeNetwork.checked) {
    try {
      network = await collectNetworkData();
    } catch (e) {
      network = [];
    }
  }
  await setPending(blob, network, "full", sourceUrl);
  setStatus(els.cameraStatus, "Full page captured — review and click Save.", "info");
}

// Bake the URL bar onto a screenshot blob and return the final PNG blob.
async function withUrlBar(thumbUrl) {
  const img = new Image();
  img.src = thumbUrl;
  await img.decode();
  const barH = 34;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height + barH;
  const ctx = canvas.getContext("2d");
  paintUrlBar(ctx, canvas.width, barH, els.url.value.trim());
  ctx.drawImage(img, 0, barH);
  return new Promise((res) => canvas.toBlob(res, "image/png"));
}

// Write every committed shot plus the current draft (if any) as PNGs, then
// one shared .md sidecar referencing all of them.
async function saveAll() {
  const shots = committedShots.map((s) => ({
    thumbUrl: s.thumbUrl,
    network: s.network,
    sourceUrl: s.sourceUrl,
  }));
  if (pendingRegionBlob) {
    shots.push({ thumbUrl: regionThumbUrl, network: pendingNetwork, sourceUrl: pendingSourceUrl });
  }
  if (!shots.length) {
    setStatus(els.cameraStatus, "Nothing to save — capture a screenshot first.", "err");
    return;
  }

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

  const url = els.url.value.trim();
  const basename = makeBasename(els.prefix.value);
  const multi = shots.length > 1;
  const pngNames = [];
  const shotNetworks = [];
  const sourceUrls = [];

  for (let i = 0; i < shots.length; i++) {
    const finalBlob = await withUrlBar(shots[i].thumbUrl);
    const filename = multi ? `${basename}-${i + 1}.png` : `${basename}.png`;
    await writeInto(baseHandle, els.subpath.value, finalBlob, filename);
    pngNames.push(filename);
    shotNetworks.push(shots[i].network || []);
    sourceUrls.push(shots[i].sourceUrl || "");
  }

  const description = els.description.value.trim();
  const prompt = els.miniPrompt.value.trim();
  let savedNote = pngNames.join(" + ");
  if (description || prompt) {
    const mdName = basename + ".md";
    const md = buildMetadataMarkdown({
      pngNames,
      sourceUrls,
      shotNetworks,
      description,
      prompt,
      url,
    });
    await writeInto(
      baseHandle,
      els.subpath.value,
      new Blob([md], { type: "text/markdown" }),
      mdName
    );
    savedNote += ` + ${mdName}`;
  }

  await clearAllShots();
  els.description.value = "";
  els.miniPrompt.value = "";
  saveDraftFields(); // persist the cleared description/prompt (URL stays)
  updatePreview();
  const parts = splitSubpath(els.subpath.value);
  const where = (parts.length ? parts.join("/") + "/" : "") + savedNote;
  setStatus(els.cameraStatus, `Saved ✓  ${baseHandle.name}/${where}`, "ok");
}

// Clear only the current draft (used by "Discard").
async function clearPendingRegion() {
  try {
    await idbDel(PENDING_KEY);
  } catch (e) {
    /* ignore */
  }
  await chrome.storage.local.remove("pendingNetwork");
  chrome.runtime.sendMessage({ type: "stf-clear-badge" }).catch(() => {});
  if (regionThumbUrl) URL.revokeObjectURL(regionThumbUrl);
  regionThumbUrl = null;
  pendingRegionBlob = null;
  pendingNetwork = [];
  pendingSource = null;
  pendingSourceUrl = "";
  setMode();
}

// Clear the draft AND the committed list (used after Save, and by "Clear all").
async function clearAllShots() {
  await clearPendingRegion();
  committedShots.forEach((s) => s.thumbUrl && URL.revokeObjectURL(s.thumbUrl));
  committedShots = [];
  try {
    await idbDel(COMMITTED_KEY);
  } catch (e) {
    /* ignore */
  }
  renderCommittedList();
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

els.addScreenshot.addEventListener("click", async () => {
  els.addScreenshot.disabled = true;
  try {
    await commitDraft();
  } catch (e) {
    setStatus(els.cameraStatus, "Failed: " + (e.message || e), "err");
  } finally {
    els.addScreenshot.disabled = false;
  }
});

els.saveAll.addEventListener("click", async () => {
  els.saveAll.disabled = true;
  setStatus(els.cameraStatus, "Saving…", "info");
  try {
    await saveAll();
  } catch (e) {
    setStatus(els.cameraStatus, "Failed: " + (e.message || e), "err");
  } finally {
    setMode(); // authoritative: enabled iff something is still pending
  }
});

els.clearAll.addEventListener("click", async () => {
  await clearAllShots();
  updatePreview();
  setStatus(els.cameraStatus, "Cleared all screenshots.", "info");
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

    // Best-effort network capture now (page is active). url/description/
    // mini-prompt/subpath/prefix are already persisted continuously
    // (see saveDraftFields and the lastSubpath/lastPrefix listeners), so
    // only the network rows need to be carried across the popup's close.
    let network = [];
    if (els.includeNetwork.checked) {
      try {
        network = await collectNetworkData();
      } catch (e) {
        network = [];
      }
    }
    await chrome.storage.local.set({ pendingNetwork: network });
    // Start fresh: drop any previously confirmed pending capture.
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
  const {
    baseName,
    lastSubpath,
    lastPrefix,
    includeNetwork,
    draftFields,
    pendingNetwork: storedNetwork,
  } = await chrome.storage.local.get([
    "baseName",
    "lastSubpath",
    "lastPrefix",
    "includeNetwork",
    "draftFields",
    "pendingNetwork",
  ]);
  chrome.storage.local.remove("pendingFields"); // dead key from an older version
  if (baseName) els.baseDisplay.value = baseName;
  if (lastSubpath) els.subpath.value = lastSubpath;
  if (lastPrefix) els.prefix.value = lastPrefix;
  // Default off when never set; otherwise honour the saved choice.
  els.includeNetwork.checked = includeNetwork === true;

  if (draftFields) {
    // Restore whatever was typed, even across a tab-switch that closed the
    // popup — this is the whole point of the draft: never lose it silently.
    els.url.value = draftFields.url || "";
    els.description.value = draftFields.description || "";
    els.miniPrompt.value = draftFields.prompt || "";
  } else {
    // No draft yet (fresh install, or right after a Save cleared it) —
    // default the URL field to the current tab's address.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) els.url.value = tab.url;
    } catch (e) {
      /* leave the field blank if the tab can't be read */
    }
  }

  // Pick up a pending (captured-but-unsaved) screenshot, if any — set either
  // by "Take full page" or by confirming an on-page area selection.
  const pendingRegion = await idbGet(PENDING_KEY);
  if (pendingRegion && pendingRegion.blob) {
    pendingRegionBlob = pendingRegion.blob;
    pendingSource = pendingRegion.source || "area";
    pendingSourceUrl = pendingRegion.sourceUrl || "";
    pendingNetwork = storedNetwork || [];
    regionThumbUrl = URL.createObjectURL(pendingRegion.blob);
    els.regionThumb.src = regionThumbUrl;
  } else if (storedNetwork) {
    // Leftover from a selection that was cancelled on the page — tidy up.
    await chrome.storage.local.remove("pendingNetwork");
  }

  // Restore any screenshots already locked in via "Add screenshot" —
  // these must survive the popup closing just like the draft does.
  const committedRaw = await idbGet(COMMITTED_KEY);
  if (committedRaw && committedRaw.length) {
    committedShots = committedRaw.map((s) => ({
      blob: s.blob,
      source: s.source,
      network: s.network || [],
      sourceUrl: s.sourceUrl || "",
      thumbUrl: URL.createObjectURL(s.blob),
    }));
    renderCommittedList();
  }

  setMode();
  updatePreview();
  showView("camera");
})();
