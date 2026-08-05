"use strict";

/* Service worker: the only context that can captureVisibleTab once the
 * popup has closed. It captures the live viewport, crops to the region the
 * user dragged, returns a preview to the on-page overlay, and stores the
 * confirmed region for the popup to save. */

importScripts("lib.js"); // idbGet/idbSet/idbDel, PENDING_KEY, REGION_TEMP_KEY

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Capture the active tab and crop to the selection (device pixels).
async function captureRegion(windowId, rect) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "png",
  });
  const fullBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(fullBlob);

  const dpr = rect.dpr || 1;
  let sx = Math.round(rect.x * dpr);
  let sy = Math.round(rect.y * dpr);
  let sw = Math.round(rect.w * dpr);
  let sh = Math.round(rect.h * dpr);
  // Clamp to the captured image bounds.
  sx = Math.max(0, Math.min(sx, bitmap.width));
  sy = Math.max(0, Math.min(sy, bitmap.height));
  sw = Math.max(1, Math.min(sw, bitmap.width - sx));
  sh = Math.max(1, Math.min(sh, bitmap.height - sy));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

async function setBadge(on) {
  try {
    await chrome.action.setBadgeText({ text: on ? "1" : "" });
    if (on) {
      await chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
    }
  } catch (e) {
    /* badge is best-effort */
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "stf-capture") {
    (async () => {
      try {
        const windowId = sender.tab ? sender.tab.windowId : undefined;
        const blob = await captureRegion(windowId, msg.rect);
        await idbSet(REGION_TEMP_KEY, blob); // hold until Confirm/Cancel
        const b64 = await blobToBase64(blob);
        sendResponse({ ok: true, b64 });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // async response
  }

  if (msg.type === "stf-confirm") {
    (async () => {
      try {
        const blob = await idbGet(REGION_TEMP_KEY);
        if (blob) await idbSet(PENDING_KEY, { blob, source: "area" });
        await idbDel(REGION_TEMP_KEY);
        await setBadge(true);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "stf-cancel") {
    (async () => {
      try {
        await idbDel(REGION_TEMP_KEY);
      } catch (e) {
        /* nothing to clean */
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "stf-clear-badge") {
    (async () => {
      await setBadge(false);
      sendResponse({ ok: true });
    })();
    return true;
  }
});
