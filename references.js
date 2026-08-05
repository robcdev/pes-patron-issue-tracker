"use strict";

/* Shared helpers (idbGet, HANDLE_KEY, ensurePermission, getSubDir,
 * splitSubpath, buildMetadataMarkdown, parseSidecar) come from lib.js. */

const els = {
  baseName: document.getElementById("base-name"),
  subpath: document.getElementById("subpath"),
  load: document.getElementById("load"),
  refresh: document.getElementById("refresh"),
  grant: document.getElementById("grant"),
  grantBtn: document.getElementById("grant-btn"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalThumb: document.getElementById("modal-thumb"),
  modalCancel: document.getElementById("modal-cancel"),
  modalSave: document.getElementById("modal-save"),
  modalDelete: document.getElementById("modal-delete"),
  modalStatus: document.getElementById("modal-status"),
  modalNetwork: document.getElementById("modal-network"),
  mUrl: document.getElementById("m-url"),
  mDescription: document.getElementById("m-description"),
  mPrompt: document.getElementById("m-prompt"),
};

let baseHandle = null;
let currentDir = null;
let objectUrls = [];
let modalUrl = null;
let editCtx = null;

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}
function setModalStatus(msg, kind) {
  els.modalStatus.textContent = msg;
  els.modalStatus.className = "status" + (kind ? " " + kind : "");
}
function clearObjectUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

/* ------------------------------------------------------------------ *
 * Render the grid of references in the current subfolder
 * ------------------------------------------------------------------ */
async function render() {
  clearObjectUrls();
  els.grid.innerHTML = "";
  setStatus("", "");

  if (!baseHandle) {
    setStatus(
      "No base folder set. Open the extension popup → ⚙️ Settings and choose one.",
      "err"
    );
    return;
  }

  if ((await baseHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
    els.grant.classList.remove("hidden");
    return;
  }
  els.grant.classList.add("hidden");

  let dir;
  try {
    dir = await getSubDir(baseHandle, els.subpath.value);
  } catch (e) {
    setStatus("This subfolder doesn't exist yet under the base folder.", "info");
    return;
  }
  currentDir = dir;

  const names = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".png")) {
      names.push(name);
    }
  }
  names.sort().reverse(); // timestamped names → newest first

  if (!names.length) {
    setStatus("No screenshots in this folder yet.", "info");
    return;
  }
  setStatus(`${names.length} reference${names.length === 1 ? "" : "s"}.`, "info");

  for (const name of names) {
    const file = await (await dir.getFileHandle(name)).getFile();
    const u = URL.createObjectURL(file);
    objectUrls.push(u);

    const mdName = name.replace(/\.png$/i, "") + ".md";
    let parsed = null;
    try {
      parsed = parseSidecar(
        await (await (await dir.getFileHandle(mdName)).getFile()).text()
      );
    } catch (e) {
      /* no sidecar yet */
    }

    els.grid.append(buildCard(name, u, parsed));
  }
}

function buildCard(name, objUrl, parsed) {
  const card = document.createElement("div");
  card.className = "card";
  card.addEventListener("click", () => openEditor(name));

  const img = document.createElement("img");
  img.className = "card-thumb";
  img.src = objUrl;
  img.alt = name;

  const body = document.createElement("div");
  body.className = "card-body";

  const nameEl = document.createElement("div");
  nameEl.className = "card-name";
  nameEl.textContent = name;

  const desc = document.createElement("div");
  desc.className = "card-desc";
  desc.textContent = (parsed && parsed.description) || "";

  const tags = document.createElement("div");
  tags.className = "card-tags";
  const detailTag = document.createElement("span");
  if (parsed) {
    detailTag.className = "tag";
    detailTag.textContent = "details";
  } else {
    detailTag.className = "tag muted";
    detailTag.textContent = "no details";
  }
  tags.append(detailTag);
  if (parsed && parsed.networkMd) {
    const net = document.createElement("span");
    net.className = "tag";
    net.textContent = "network";
    tags.append(net);
  }

  body.append(nameEl, desc, tags);
  card.append(img, body);
  return card;
}

/* ------------------------------------------------------------------ *
 * Editor modal
 * ------------------------------------------------------------------ */
async function openEditor(pngName) {
  if (!currentDir) return;
  const mdName = pngName.replace(/\.png$/i, "") + ".md";
  let parsed = {
    description: "",
    prompt: "",
    url: "",
    captured: "",
    networkMd: "",
    pngNames: [],
    sourceUrls: [],
  };
  try {
    parsed = parseSidecar(
      await (await (await currentDir.getFileHandle(mdName)).getFile()).text()
    );
  } catch (e) {
    /* no sidecar — start blank */
  }

  editCtx = {
    pngName,
    mdName,
    captured: parsed.captured,
    networkMd: parsed.networkMd,
    // Preserve every image (and its per-image source URL) the sidecar
    // already references — a capture from the popup's multi-screenshot flow
    // may list more than just this one; editing text here must not
    // silently drop them.
    pngNames: parsed.pngNames && parsed.pngNames.length ? parsed.pngNames : [pngName],
    sourceUrls: parsed.sourceUrls || [],
  };

  els.modalTitle.textContent = pngName;
  try {
    const file = await (await currentDir.getFileHandle(pngName)).getFile();
    if (modalUrl) URL.revokeObjectURL(modalUrl);
    modalUrl = URL.createObjectURL(file);
    els.modalThumb.src = modalUrl;
  } catch (e) {
    /* preview is best-effort */
  }

  els.mUrl.value = parsed.url;
  els.mDescription.value = parsed.description;
  els.mPrompt.value = parsed.prompt;
  els.modalNetwork.textContent = parsed.networkMd
    ? "Captured network data is attached and will be preserved when you save."
    : "";
  setModalStatus("", "");
  els.modal.classList.remove("hidden");
}

function closeEditor() {
  els.modal.classList.add("hidden");
  if (modalUrl) {
    URL.revokeObjectURL(modalUrl);
    modalUrl = null;
  }
  els.modalThumb.removeAttribute("src");
  editCtx = null;
}

async function saveEditor() {
  if (!editCtx || !currentDir) return;
  const { pngNames, sourceUrls, mdName, captured, networkMd } = editCtx;
  const description = els.mDescription.value.trim();
  const prompt = els.mPrompt.value.trim();
  const url = els.mUrl.value.trim();

  try {
    if (!description && !prompt && !url) {
      // Nothing left to store — drop the sidecar if one exists.
      try {
        await currentDir.removeEntry(mdName);
      } catch (e) {
        /* nothing to remove */
      }
    } else {
      const md = buildMetadataMarkdown({
        pngNames,
        sourceUrls,
        description,
        prompt,
        url,
        captured,
        networkMd,
      });
      const fh = await currentDir.getFileHandle(mdName, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([md], { type: "text/markdown" }));
      await w.close();
    }
    closeEditor();
    await render();
    setStatus(`Saved ✓  ${mdName}`, "ok");
  } catch (e) {
    setModalStatus("Failed to save: " + (e.message || e), "err");
  }
}

async function deleteEditor() {
  if (!editCtx || !currentDir) return;
  const { pngName, mdName } = editCtx;
  if (!confirm(`Delete ${pngName} and its details file? This removes the files.`)) {
    return;
  }
  try {
    await currentDir.removeEntry(pngName);
    try {
      await currentDir.removeEntry(mdName);
    } catch (e) {
      /* sidecar may not exist */
    }
    closeEditor();
    await render();
    setStatus(`Deleted  ${pngName}`, "info");
  } catch (e) {
    setModalStatus("Failed to delete: " + (e.message || e), "err");
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
els.load.addEventListener("click", render);
els.refresh.addEventListener("click", render);
els.subpath.addEventListener("keydown", (e) => {
  if (e.key === "Enter") render();
});
els.grantBtn.addEventListener("click", async () => {
  if (await ensurePermission(baseHandle)) render();
  else setStatus("Permission was denied.", "err");
});
els.modalSave.addEventListener("click", saveEditor);
els.modalDelete.addEventListener("click", deleteEditor);
els.modalCancel.addEventListener("click", closeEditor);
els.modal.addEventListener("click", (e) => {
  if (e.target === els.modal) closeEditor(); // click backdrop to dismiss
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.modal.classList.contains("hidden")) closeEditor();
});

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */
(async function init() {
  const params = new URLSearchParams(location.search);
  let sub = params.get("sub");
  if (sub == null) {
    const { lastSubpath } = await chrome.storage.local.get(["lastSubpath"]);
    sub = lastSubpath || "";
  }
  els.subpath.value = sub;

  baseHandle = await idbGet(HANDLE_KEY);
  els.baseName.textContent = baseHandle ? baseHandle.name : "(no base folder)";
  await render();
})();
