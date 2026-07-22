# Screenshot to Folder

A minimal Chrome extension for a fast dev loop: capture the visible page (with
its URL baked into the image) and drop it straight into a chosen folder +
subfolder — no manual "save → find → copy → paste into the worktree" dance.

## How it works

- **Settings (⚙️)** — pick a **base folder** *once* via the OS folder dialog.
  The choice is remembered across browser restarts (stored as a
  `FileSystemDirectoryHandle` in IndexedDB). This is your stable root, e.g.
  `/Users/roberth/Documents/dev/spaceti`.
- **Camera (📷)** — a **subfolder** field (e.g. `worktree-x/reference`) plus a
  **Take** button. The subfolder is the part you change often; its last value
  is remembered so you don't retype it. Nested subfolders are created
  automatically if they don't exist.
- On **Take full page**: the visible page is captured
  (`chrome.tabs.captureVisibleTab` — browser tabs/toolbar are *not* in the
  image), the page URL is drawn as a bar across the top, and the PNG is written
  to `‹base folder›/‹subfolder›/‹prefix›-YYYY-MM-DD_HH-MM-SS.png`.
- On **Select area…**: the viewport is captured and opened in a crop page
  (`capture.html`) where you drag a rectangle to pick a region, then **Save**.
  Only that region is written (with the same URL bar, filename, fields and
  sidecar as the full-page path). See [Region capture](#region-capture-select-area).

## Issue metadata (for Claude)

The camera tab has a **URL** field that auto-populates with the current tab's
address when the popup opens. It's editable, and its value is used both for the
URL bar baked into the image and for the `url` line in the sidecar below.

The tab also has two optional fields — **Issue description** and
**Mini-prompt for Claude** (the "issue" can be a bug *or* a feature request).
When either is filled in, **Take** writes a Markdown sidecar next to the
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

These two fields are **per-issue**: they're not remembered between captures and are
cleared after a successful **Take** (the subfolder and prefix still persist). If
both are left blank, only the PNG is written.

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

Like macOS ⌘⇧4, but within a browser extension's limits. A popup **closes the
moment you click the page**, and only a window (not a background worker) can
reliably write to your chosen folder — so instead of a live on-page overlay, the
flow is:

1. Fill in the fields as usual and click **Select area…**.
2. The extension captures the current viewport and opens a **crop page** in a new
   tab with that screenshot frozen in place.
3. **Drag a rectangle** over the part you want (the selection size in real pixels
   is shown live); adjust the carried-over fields if needed.
4. **Save section** — only the selected region is cropped, gets the URL bar, and
   is written exactly like a full-page shot, including the `.md` sidecar (with any
   captured network data) when a description or mini-prompt is present.

The captured image and field values are handed to the crop page through
IndexedDB, so nothing is lost when the popup closes.

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
