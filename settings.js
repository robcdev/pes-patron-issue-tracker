"use strict";

/* Shared helpers (idbSet/idbGet/idbDel, HANDLE_KEY) come from lib.js.
 *
 * This lives in its own tab rather than a popup view on purpose: choosing a
 * folder calls window.showDirectoryPicker(), which opens the OS's native
 * folder dialog. On some platforms/window-managers (observed with GTK on
 * Ubuntu) that dialog steals focus from the invoking window, and a Chrome
 * extension *popup* closes the instant it loses focus — killing this
 * script mid-`await` before the selection is ever saved. A normal tab does
 * not have that behavior, so the picker works reliably here regardless of
 * OS. */

const els = {
  baseDisplay: document.getElementById("base-display"),
  chooseFolder: document.getElementById("choose-folder"),
  forgetFolder: document.getElementById("forget-folder"),
  status: document.getElementById("status"),
};

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

els.chooseFolder.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet(HANDLE_KEY, handle);
    await chrome.storage.local.set({ baseName: handle.name });
    els.baseDisplay.value = handle.name;
    setStatus(`Base folder set: ${handle.name}`, "ok");
  } catch (e) {
    if (e && e.name === "AbortError") return; // user cancelled picker
    setStatus("Could not set folder: " + (e.message || e), "err");
  }
});

els.forgetFolder.addEventListener("click", async () => {
  await idbDel(HANDLE_KEY);
  await chrome.storage.local.remove("baseName");
  els.baseDisplay.value = "";
  setStatus("Folder forgotten.", "info");
});

(async function init() {
  const { baseName } = await chrome.storage.local.get(["baseName"]);
  if (baseName) els.baseDisplay.value = baseName;
})();
