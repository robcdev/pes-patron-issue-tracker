# Screenshot to Folder

A minimal Chrome extension for a fast dev loop: capture the visible page (with
its URL baked into the image) and drop it straight into a chosen folder +
subfolder — no manual "save → find → copy → paste into the worktree" dance.

## How it works

- **Settings (⚙️)** — pick a **base folder** *once* via the OS folder dialog.
  The choice is remembered across browser restarts (stored as a
  `FileSystemDirectoryHandle` in IndexedDB). This is your stable root, e.g.
  `/Users/roberth/Documents/dev/spaceti`.
- **Camera (📷)** — a **subfolder** field (e.g. `worktree-x/reference`) plus the
  capture/save buttons. The subfolder is the part you change often; its last
  value is remembered so you don't retype it. Nested subfolders are created
  automatically if they don't exist.
- **Capture then save.** Both **Take full page** and **Select area…** *capture*
  a screenshot into a **preview** — nothing is written yet. **Take full page**
  grabs the visible viewport (`chrome.tabs.captureVisibleTab` — browser
  tabs/toolbar are *not* in the image); **Select area…** lets you drag a region
  on the live page (see [Region capture](#region-capture-select-area)).
- **Save** writes the previewed screenshot together with the *current* field
  state (URL, description, mini-prompt, …). The page URL is drawn as a bar across
  the top and the PNG is written to
  `‹base folder›/‹subfolder›/‹prefix›-YYYY-MM-DD_HH-MM-SS.png`. **Discard** clears
  the preview. Re-capturing (either button) replaces the preview.

## Issue metadata (for Claude)

The camera tab has a **URL** field that auto-populates with the current tab's
address when the popup opens. It's editable, and its value is used both for the
URL bar baked into the image and for the `url` line in the sidecar below.

The tab also has two optional fields — **Issue description** and
**Mini-prompt for Claude** (the "issue" can be a bug *or* a feature request).
When either is filled in, **Save** writes a Markdown sidecar next to the
screenshot, sharing the same basename:

```
‹subfolder›/meetings-daily-scrum-2026-07-15_10-00-05.png
‹subfolder›/meetings-daily-scrum-2026-07-15_10-00-05.md
```

The `.md` embeds the image and records the context, so when Claude works in that
folder it reads the bug description, your instruction, and the page URL, then
follows the `![screenshot](…)` link to the image:

```markdown
# Issue: the meetings component does not display the time correctly

![screenshot](meetings-daily-scrum-2026-07-15_10-00-05.png)

**Description:** the meetings component does not display the time correctly

**Prompt:** make the field a little wider so the data fits

**URL:** https://…
**Captured:** 2026-07-15 10:00:05
```

These two fields are **per-issue**: they're cleared after a successful **Save**
(the subfolder and prefix still persist indefinitely). If both are left blank,
only the PNG is written.

Until you Save, though, nothing you type is at risk — see
[Draft persistence](#draft-persistence) below.

### Draft persistence

A Chrome extension popup **closes the instant it loses focus** — clicking the
page, switching tabs, or alt-tabbing away all close it. So that this never costs
you typed text: the **URL**, **Issue description**, and **Mini-prompt** fields
are saved to `chrome.storage` on every keystroke and restored exactly as typed
the next time the popup opens. They're only cleared once you actually click
**Save** (or **Take full page**/**Select area…** replace an unsaved capture —
see below). The same applies to a **captured-but-unsaved screenshot**: both the
full-page and area-selection previews are persisted (IndexedDB for the image,
`chrome.storage` for any captured network rows), so switching tabs mid-review
doesn't lose the shot either — reopen the popup and the preview and **Save**
button are still there.

### Network data

Check the **Include network data** checkbox (off by default) to add a `## Network`
table to the sidecar, listing every request the page made since it loaded —
status, type, transfer size, duration and URL — read from the page's
[Resource Timing](https://developer.mozilla.org/docs/Web/API/PerformanceResourceTiming)
API (the same source as the DevTools waterfall). Your choice is remembered.

```markdown
## Network (42 requests via Resource Timing, 1 failed)

| status | type | size | ms | url |
| --- | --- | --- | --- | --- |
| 200 | navigation | 6.1 KB | 340 | https://app.example.com/meetings |
| 500 | fetch | 1.1 KB | 210 | https://app.example.com/api/time-format |
```

Notes: it captures request metadata only (no request/response **bodies** or
headers); status codes need Chrome 109+ and, for cross-origin requests, a
`Timing-Allow-Origin` header (otherwise status shows `—`); it only sees requests
made since the current page load; and the network capture is best-effort — if it
fails, the screenshot and the rest of the sidecar are still saved. The table is
capped at 200 rows.

## Region capture (Select area…)

A live on-page selection, like macOS ⌘⇧4:

1. Fill in the fields and click **Select area…**. The popup closes and a
   crosshair overlay appears **on the current page** (your field values are
   remembered). Press **Esc** to cancel.
2. **Drag a rectangle** over the region you want. On release, the live page is
   captured at that moment and a **preview modal** shows the crop with
   **Confirm** / **Cancel**.
3. **Confirm** stores that region as the pending screenshot. Reopen the
   extension (its icon shows a badge): the **preview appears above the
   "Saving to:" path**, with a **Save** button beside it.
4. **Save** writes it exactly like a full-page shot — URL bar baked on, plus the
   `.md` sidecar (with any network data captured at selection time) when a
   description or mini-prompt is present. **Discard** clears the preview, and
   **Retake area** starts a new selection.

**Take full page** stays available at all times, so you never have to make a
selection when you just want the whole viewport — it also fills the preview and
is written only when you click **Save**.

### How it works (extension constraints)

A popup **closes the instant the page gets focus**, and only a window context can
reliably write to your chosen folder — so the work is split:

- **`overlay.js`** is injected into the tab to draw the selection and the
  Confirm/Cancel preview (styled via inline properties and a `<canvas>`, so it
  works under strict page CSPs).
- **`background.js`** (service worker) is the only context that can
  `captureVisibleTab` once the popup is gone; it captures and crops the region.
- The confirmed crop is stashed in IndexedDB and the fields in `chrome.storage`,
  so the popup restores everything and does the actual save when you reopen it.

## Managing references (✏️)

The **✏️** button in the popup opens a full **references page in its own browser
tab** (`references.html`). It shows every screenshot in a folder as a responsive
grid of previews, each tagged with whether it has details / network data.

- The page opens on the popup's current **subfolder**; you can type a different
  subfolder in the header bar and hit **Load** (or Enter) to browse elsewhere
  under the same base folder, and **Refresh** to re-scan.
- **Click any card** to open the editor: a large preview beside the editable
  fields (URL, issue description, mini-prompt). **Save** rewrites the `.md`
  sidecar in place — any captured `## Network` section is preserved untouched,
  and clearing all fields removes the sidecar. **Delete reference** removes the
  screenshot *and* its `.md` sidecar together (after a confirmation).
- The first time the page opens after a browser restart it asks you to **Grant
  folder access** (Chrome re-confirming read/write to the chosen folder).

Editing round-trips reliably thanks to a small `<!-- stf-meta: … -->` block
appended to each sidecar — invisible in rendered Markdown, authoritative when the
editor re-opens the file.

The popup and the references page share their code (`lib.js`) and the same stored
base-folder handle, so no re-picking is needed.

## Why pick-a-folder instead of typing a path

Chrome extensions cannot write to an arbitrary typed absolute path — the
`downloads` API only allows the Downloads folder. The **File System Access API**
(`showDirectoryPicker`) is the only way to write into a real arbitrary folder
with no native helper to install. You pick the base folder once; everything
after that is just typing the subfolder.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this `screenshot-to-folder-extension`
   folder.
4. Pin the extension, click its icon → **⚙️ Settings** → **Choose…** and select
   your base folder (grant read/write when prompted).

## Notes / limitations

- The first save after a browser restart may show a one-time permission prompt
  for the chosen folder — that's Chrome re-confirming write access. Click allow.
- Capturing is blocked by Chrome on internal pages (`chrome://…`, the Web
  Store). Use it on normal http/https pages.
- Only the **visible viewport** is captured (this is Chrome's API behavior), not
  the full scrollable page.
