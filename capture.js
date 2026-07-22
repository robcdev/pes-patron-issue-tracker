"use strict";

/* Shared helpers (idbGet/idbSet/idbDel, HANDLE_KEY, PENDING_KEY,
 * ensurePermission, splitSubpath, makeBasename, paintUrlBar, writeInto,
 * buildMetadataMarkdown) come from lib.js, loaded first. */

const els = {
  empty: document.getElementById("empty"),
  workspace: document.getElementById("workspace"),
  stage: document.getElementById("stage"),
  shot: document.getElementById("shot"),
  sel: document.getElementById("sel"),
  selInfo: document.getElementById("sel-info"),
  subpath: document.getElementById("subpath"),
  prefix: document.getElementById("prefix"),
  url: document.getElementById("url"),
  description: document.getElementById("description"),
  miniPrompt: document.getElementById("mini-prompt"),
  networkNote: document.getElementById("network-note"),
  targetPreview: document.getElementById("target-preview"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  status: document.getElementById("status"),
};

let pending = null; // { blob, url, subpath, prefix, description, prompt, network, baseName }
let shotUrl = null; // object URL for the screenshot
// Selection rectangle in stage (CSS) pixels.
let sel = null; // { x, y, w, h }
let drag = null; // { startX, startY }

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function updatePreview() {
  const base = (pending && pending.baseName) || "<base folder>";
  const parts = splitSubpath(els.subpath.value);
  const joined = parts.length ? base + "/" + parts.join("/") : base;
  els.targetPreview.textContent =
    joined + "/" + makeBasename(els.prefix.value) + ".png";
}

/* ------------------------------------------------------------------ *
 * Selection (drag a rectangle over the scaled screenshot)
 * ------------------------------------------------------------------ */
function stageRect() {
  return els.stage.getBoundingClientRect();
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function drawSelection() {
  if (!sel || sel.w < 1 || sel.h < 1) {
    els.sel.classList.add("hidden");
    return;
  }
  els.sel.classList.remove("hidden");
  els.sel.style.left = sel.x + "px";
  els.sel.style.top = sel.y + "px";
  els.sel.style.width = sel.w + "px";
  els.sel.style.height = sel.h + "px";
}

// CSS→image-pixel scale (image is shown scaled to fit).
function pixelScale() {
  return els.shot.naturalWidth / els.shot.clientWidth;
}

function refreshSelInfo() {
  const usable = sel && sel.w >= 4 && sel.h >= 4;
  els.save.disabled = !usable;
  if (!usable) {
    els.selInfo.textContent = "No selection yet — drag on the image.";
    return;
  }
  const s = pixelScale();
  els.selInfo.textContent = `Selection: ${Math.round(sel.w * s)} × ${Math.round(
    sel.h * s
  )} px`;
}

function onDown(e) {
  const r = stageRect();
  const x = clamp(e.clientX - r.left, 0, r.width);
  const y = clamp(e.clientY - r.top, 0, r.height);
  drag = { startX: x, startY: y };
  sel = { x, y, w: 0, h: 0 };
  drawSelection();
  e.preventDefault();
}
function onMove(e) {
  if (!drag) return;
  const r = stageRect();
  const x = clamp(e.clientX - r.left, 0, r.width);
  const y = clamp(e.clientY - r.top, 0, r.height);
  sel = {
    x: Math.min(drag.startX, x),
    y: Math.min(drag.startY, y),
    w: Math.abs(x - drag.startX),
    h: Math.abs(y - drag.startY),
  };
  drawSelection();
  refreshSelInfo();
}
function onUp() {
  if (!drag) return;
  drag = null;
  refreshSelInfo();
}

function clearSelection() {
  sel = null;
  drawSelection();
  refreshSelInfo();
}

/* ------------------------------------------------------------------ *
 * Save the cropped region (+ sidecar), same logic as the full-page path
 * ------------------------------------------------------------------ */
async function save() {
  if (!pending || !sel || sel.w < 4 || sel.h < 4) return;
  els.save.disabled = true;
  setStatus("Saving…", "info");
  try {
    const baseHandle = await idbGet(HANDLE_KEY);
    if (!baseHandle) {
      setStatus("No base folder set. Choose one in the extension settings.", "err");
      return;
    }
    if (!(await ensurePermission(baseHandle))) {
      setStatus("Permission to write to the folder was denied.", "err");
      els.save.disabled = false;
      return;
    }

    const scale = pixelScale();
    const sx = Math.round(sel.x * scale);
    const sy = Math.round(sel.y * scale);
    const sw = Math.round(sel.w * scale);
    const sh = Math.round(sel.h * scale);

    const url = els.url.value.trim();
    const barH = 34;
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh + barH;
    const ctx = canvas.getContext("2d");
    paintUrlBar(ctx, canvas.width, barH, url);
    ctx.drawImage(els.shot, sx, sy, sw, sh, 0, barH, sw, sh);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));

    const subpath = els.subpath.value;
    const basename = makeBasename(els.prefix.value);
    const filename = basename + ".png";
    await writeInto(baseHandle, subpath, blob, filename);

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
        network: pending.network || [],
      });
      await writeInto(
        baseHandle,
        subpath,
        new Blob([md], { type: "text/markdown" }),
        mdName
      );
      savedNote = `${filename} + ${mdName}`;
    }

    await idbDel(PENDING_KEY); // consume the pending capture
    const parts = splitSubpath(subpath);
    const where = (parts.length ? parts.join("/") + "/" : "") + savedNote;
    setStatus(`Saved ✓  ${baseHandle.name}/${where} — you can close this tab.`, "ok");
    els.reset.disabled = true;
  } catch (e) {
    setStatus("Failed: " + (e.message || e), "err");
    els.save.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring + init
 * ------------------------------------------------------------------ */
els.stage.addEventListener("mousedown", onDown);
document.addEventListener("mousemove", onMove);
document.addEventListener("mouseup", onUp);
els.save.addEventListener("click", save);
els.reset.addEventListener("click", clearSelection);
els.subpath.addEventListener("input", updatePreview);
els.prefix.addEventListener("input", updatePreview);

(async function init() {
  pending = await idbGet(PENDING_KEY);
  if (!pending || !pending.blob) {
    els.empty.classList.remove("hidden");
    return;
  }
  els.workspace.classList.remove("hidden");

  shotUrl = URL.createObjectURL(pending.blob);
  els.shot.src = shotUrl;

  els.subpath.value = pending.subpath || "";
  els.prefix.value = pending.prefix || "";
  els.url.value = pending.url || "";
  els.description.value = pending.description || "";
  els.miniPrompt.value = pending.prompt || "";
  const n = (pending.network && pending.network.length) || 0;
  els.networkNote.textContent = n
    ? `${n} network request(s) captured — included in the sidecar.`
    : "";

  updatePreview();
  refreshSelInfo();
})();
