"use strict";

/* Injected into the active tab by the popup. Draws a crosshair selection
 * over the LIVE page; on release it asks the background worker to capture
 * and crop the current viewport, then shows a Confirm/Cancel preview.
 *
 * Styling is applied via element.style (not <style>/style attributes) and
 * the preview is drawn to a <canvas> from decoded bytes (not <img src>),
 * so it works under strict page Content-Security-Policies. */

(function () {
  if (window.__stfOverlayActive) return;
  window.__stfOverlayActive = true;

  const Z = "2147483647";
  let root, dim, selBox, hint, modal;
  let startX = 0,
    startY = 0,
    dragging = false,
    sel = null,
    busy = false;

  function css(el, styles) {
    Object.assign(el.style, styles);
    return el;
  }

  function build() {
    root = document.createElement("div");
    css(root, {
      position: "fixed",
      inset: "0",
      zIndex: Z,
      cursor: "crosshair",
      userSelect: "none",
    });

    dim = document.createElement("div");
    css(dim, {
      position: "absolute",
      inset: "0",
      background: "rgba(15,17,26,0.35)",
    });

    selBox = document.createElement("div");
    css(selBox, {
      position: "absolute",
      display: "none",
      border: "1.5px solid #4f46e5",
      background: "rgba(79,70,229,0.10)",
      boxShadow: "0 0 0 9999px rgba(15,17,26,0.35)",
      pointerEvents: "none",
    });

    hint = document.createElement("div");
    hint.textContent = "Drag to select an area  ·  Esc to cancel";
    css(hint, {
      position: "absolute",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#111827",
      color: "#fff",
      font: "600 13px -apple-system, Segoe UI, Roboto, sans-serif",
      padding: "8px 14px",
      borderRadius: "999px",
      boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
      pointerEvents: "none",
    });

    root.append(dim, selBox, hint);
    document.documentElement.append(root);
  }

  function setSelBox(x, y, w, h) {
    css(selBox, {
      display: "block",
      left: x + "px",
      top: y + "px",
      width: w + "px",
      height: h + "px",
    });
  }

  function onDown(e) {
    if (busy || modal) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    sel = { x: startX, y: startY, w: 0, h: 0 };
    setSelBox(startX, startY, 0, 0);
    e.preventDefault();
    e.stopPropagation();
  }
  function onMove(e) {
    if (!dragging) return;
    const x = Math.max(0, Math.min(e.clientX, window.innerWidth));
    const y = Math.max(0, Math.min(e.clientY, window.innerHeight));
    sel = {
      x: Math.min(startX, x),
      y: Math.min(startY, y),
      w: Math.abs(x - startX),
      h: Math.abs(y - startY),
    };
    setSelBox(sel.x, sel.y, sel.w, sel.h);
    e.preventDefault();
  }
  async function onUp(e) {
    if (!dragging) return;
    dragging = false;
    e.preventDefault();
    e.stopPropagation();
    if (!sel || sel.w < 4 || sel.h < 4) {
      selBox.style.display = "none";
      sel = null;
      return;
    }
    await capture();
  }

  async function capture() {
    busy = true;
    hint.style.display = "none";
    // Hide our chrome so the screenshot is clean, then let it repaint.
    root.style.display = "none";
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "stf-capture",
        rect: { ...sel, dpr: window.devicePixelRatio || 1 },
      });
    } catch (e) {
      resp = { ok: false, error: String(e) };
    }

    root.style.display = "";
    if (!resp || !resp.ok) {
      toast("Capture failed: " + ((resp && resp.error) || "unknown"), true);
      reset();
      busy = false;
      return;
    }
    await showPreview(resp.b64);
    busy = false;
  }

  async function decodeToCanvas(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    // Display size (cap the longest side so the card fits on screen).
    const maxW = Math.min(560, window.innerWidth - 120);
    const maxH = window.innerHeight - 220;
    const scale = Math.min(1, maxW / canvas.width, maxH / canvas.height);
    css(canvas, {
      width: Math.round(canvas.width * scale) + "px",
      height: Math.round(canvas.height * scale) + "px",
      borderRadius: "8px",
      border: "1px solid #e3e5ee",
      display: "block",
      background: "#f4f5f9",
    });
    return canvas;
  }

  async function showPreview(b64) {
    selBox.style.display = "none";
    dim.style.background = "rgba(15,17,26,0.55)";

    modal = document.createElement("div");
    css(modal, {
      position: "absolute",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
    });

    const card = document.createElement("div");
    css(card, {
      background: "#fff",
      borderRadius: "14px",
      padding: "18px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      maxWidth: "620px",
      font: "14px -apple-system, Segoe UI, Roboto, sans-serif",
      color: "#1f2330",
    });

    const title = document.createElement("div");
    title.textContent = "Use this selection?";
    css(title, { fontWeight: "700", fontSize: "16px", marginBottom: "12px" });

    const canvas = await decodeToCanvas(b64);

    const actions = document.createElement("div");
    css(actions, {
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
      marginTop: "16px",
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    css(cancelBtn, {
      padding: "9px 16px",
      border: "1px solid #d6d9e2",
      borderRadius: "8px",
      background: "#fff",
      color: "#3a3f51",
      fontWeight: "600",
      cursor: "pointer",
    });
    cancelBtn.addEventListener("click", onCancel);

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm";
    css(confirmBtn, {
      padding: "9px 18px",
      border: "none",
      borderRadius: "8px",
      background: "#4f46e5",
      color: "#fff",
      fontWeight: "600",
      cursor: "pointer",
    });
    confirmBtn.addEventListener("click", onConfirm);

    actions.append(cancelBtn, confirmBtn);
    card.append(title, canvas, actions);
    modal.append(card);
    root.append(modal);
  }

  async function onConfirm() {
    try {
      await chrome.runtime.sendMessage({ type: "stf-confirm" });
    } catch (e) {
      /* ignore */
    }
    cleanup();
    toastDetached(
      "Selection captured — open the Screenshot to Folder popup to review & save."
    );
  }

  async function onCancel() {
    try {
      await chrome.runtime.sendMessage({ type: "stf-cancel" });
    } catch (e) {
      /* ignore */
    }
    reset();
  }

  // Discard the current selection/preview and return to crosshair mode.
  function reset() {
    if (modal) {
      modal.remove();
      modal = null;
    }
    sel = null;
    selBox.style.display = "none";
    dim.style.background = "rgba(15,17,26,0.35)";
    hint.style.display = "";
  }

  function toast(text, isError) {
    const t = document.createElement("div");
    t.textContent = text;
    css(t, {
      position: "absolute",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      background: isError ? "#b91c1c" : "#111827",
      color: "#fff",
      font: "600 13px -apple-system, Segoe UI, Roboto, sans-serif",
      padding: "10px 16px",
      borderRadius: "10px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.3)",
    });
    root.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // A toast that survives cleanup (own element on <html>, self-removing).
  function toastDetached(text) {
    const t = document.createElement("div");
    t.textContent = text;
    css(t, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: Z,
      background: "#111827",
      color: "#fff",
      font: "600 13px -apple-system, Segoe UI, Roboto, sans-serif",
      padding: "10px 16px",
      borderRadius: "10px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.3)",
    });
    document.documentElement.append(t);
    setTimeout(() => t.remove(), 3200);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "stf-cancel" }).catch(() => {});
      cleanup();
    }
  }

  function cleanup() {
    document.removeEventListener("keydown", onKey, true);
    root.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    if (root) root.remove();
    window.__stfOverlayActive = false;
  }

  build();
  root.addEventListener("mousedown", onDown, true);
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  document.addEventListener("keydown", onKey, true);
})();
