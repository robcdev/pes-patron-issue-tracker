# Screenshot to Folder

A minimal Chrome extension for a fast dev loop: capture the visible page (with
its URL baked into the image) and drop it straight into a chosen folder +
subfolder — no manual "save → find → copy → paste into the worktree" dance.

## How it works

- **Settings (⚙️)** — opens `settings.html` in its own browser tab (see
  [Settings runs in its own tab](#settings-runs-in-its-own-tab) for why) where
  you pick a **base folder** *once* via the OS folder dialog. The choice is
  remembered across browser restarts (stored as a `FileSystemDirectoryHandle`
  in IndexedDB). This is your stable root, e.g. `/Users/roberth/Documents/dev/spaceti`.
- **Camera (📷)** — a **subfolder** field (e.g. `worktree-x/reference`) plus the
  capture/save buttons. The subfolder is the part you change often; its last
  value is remembered so you don't retype it. Nested subfolders are created
  automatically if they don't exist.
- **Capture then save.** Both **Take full page** and **Select area…** *capture*
  a screenshot into a **draft preview** — nothing is written yet. **Take full
  page** grabs the visible viewport (`chrome.tabs.captureVisibleTab` — browser
  tabs/toolbar are *not* in the image); **Select area…** lets you drag a region
  on the live page (see [Region capture](#region-capture-select-area)). Capturing
  again replaces the draft — click **Add screenshot** first if you want to keep
  it (see [Multiple screenshots per issue](#multiple-screenshots-per-issue)).
- **Save** (a standalone button, not part of any single preview) writes every
  screenshot you've captured — the draft plus anything added — together with the
  *current* field state (URL, description, mini-prompt, …). The page URL is
  drawn as a bar across the top of each image. **Discard** clears just the
  draft; **Clear all screenshots** clears everything.

## Issue metadata (for Claude)

The camera tab has a **URL** field that auto-populates with the current tab's
address **every time the popup opens** — open it on `ddd.com` and the field
reads `ddd.com`. It's editable, and its value is used both for the URL bar baked
into the image and for the `url` line in the sidecar below.

Typing in the field **pins** what you typed: the auto-fill stops overwriting it,
including across the tab switches described under *Draft persistence* below.
Emptying the field releases the pin and hands it back to the auto-fill, and so
does a successful **Save** — that ends the capture cycle, so the next one starts
from wherever the browser actually is.

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
**From:** https://…

**Description:** the meetings component does not display the time correctly

**Prompt:** make the field a little wider so the data fits

**URL:** https://…
**Captured:** 2026-07-15 10:00:05
```

The `**From:**` line under each image is the **actual tab URL that screenshot was
captured from** — auto-detected at capture time, one per image, never edited by
hand. It's separate from the `**URL:**` field above (which stays a single,
editable, shared value, same as always) — `**From:**` is what lets Claude tell
which screenshot maps to which page, especially useful when comparing shots from
different tabs (see [Multiple screenshots per issue](#multiple-screenshots-per-issue)).

These two fields are **per-issue**: they're cleared after a successful **Save**
(the subfolder and prefix still persist indefinitely). If both are left blank,
only the PNG(s) are written.

Until you Save, though, nothing you type — or capture — is at risk — see
[Draft persistence](#draft-persistence) below.

### Multiple screenshots per issue

One issue often needs more than one screenshot — e.g. a bug that spans two
pages, or shots from different browser tabs. **Add screenshot** (shown next to
the draft preview once you've captured something) locks that draft into a
running list and clears the slot so **Take full page**/**Select area…** can
capture the next one. Each item in the list shows a thumbnail and a **Remove**
link. **Save** (see above) writes the whole list — draft included, so you don't
have to remember to click Add screenshot for the very last shot.

With more than one screenshot, filenames get an index and all of them share one
sidecar:

```
‹subfolder›/meetings-daily-scrum-2026-07-15_10-00-05-1.png
‹subfolder›/meetings-daily-scrum-2026-07-15_10-00-05-2.png
‹subfolder›/meetings-daily-scrum-2026-07-15_10-00-05.md
```

The `.md` embeds every image in order (`![screenshot 1](…)`, `![screenshot
2](…)`, …), each immediately followed by its own `**From:**` (the page it was
captured from) and, if network/console data was captured for that shot, its own
`## Network` table and `## Console` block. **Description** and **Prompt** stay a single shared pair
covering the whole set — exactly the "look at image 1, then image 2, they
differ because…" comparison case. With a single screenshot, naming and the
sidecar are unchanged from before — no `-1` suffix.

Because each capture can come from a **different browser tab**, both the
already-added list and the current draft persist across tab switches the same
way the text fields do — see below.

### Draft persistence

A Chrome extension popup **closes the instant it loses focus** — clicking the
page, switching tabs, or alt-tabbing away all close it. So that this never costs
you typed text or a captured shot: the **URL**, **Issue description**, and
**Mini-prompt** fields are saved to `chrome.storage` on every keystroke and
restored exactly as typed the next time the popup opens — cleared only once you
actually click **Save**. (The URL is restored only if you typed it by hand;
otherwise it re-reads the current tab — see *Issue metadata* above.) The current **draft screenshot** and the **list of
already-added screenshots** are persisted the same way (IndexedDB for the
images, `chrome.storage` for their network/console rows), so switching tabs mid-review —
even between captures of different tabs — never loses anything: reopen the
popup and everything is exactly where you left it.

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

### Console data

Check the **Include console data** checkbox (off by default) to add a `##
Console` block to the sidecar with everything the page logged — `log`, `info`,
`warn`, `error`, `debug`, plus uncaught errors and unhandled promise rejections
— each with a timestamp and level. Your choice is remembered.

````markdown
## Console (12 messages, 2 errors)

```text
[10:00:03.118] LOG   [MeetingList] rendering 14 rows
[10:00:03.402] ERROR Uncaught TypeError: t.format is not a function
    at formatTime (meetings.js:212)
```
````

Unlike network data — which the browser records for us and hands over on demand
— **nothing keeps a console history**, so the extension has to be listening
before the message is logged. `console-hook.js` runs in the page's *main world*
at `document_start` (declared in the manifest) and wraps `console.*` into a
capped in-page ring buffer, which the popup reads at capture time.

The practical consequence: **a tab that was already open when the extension was
installed or reloaded has no recording at all.** Rather than silently attaching
an empty log, the popup says so and asks you to reload the page — when you tick
the checkbox, when you take a full-page shot, and before it opens the area
selector. It buffers the most recent 500 messages (each truncated at 2 000
characters); the sidecar renders the last 200. Message arguments are formatted
much like DevTools does: `Error`s become their stack, objects are JSON, circular
references show as `[Circular]`.

Because the recorder must run on every page, the extension declares
`host_permissions: <all_urls>` — Chrome shows this at install as *"Read and
change all your data on all websites"*. It only wraps `console.*` and reads back
what the page itself logged; nothing is sent anywhere.

If either box is ticked and data is captured, the sidecar is written **even when
you leave the description and mini-prompt empty** — a log you can't retype is
worth a file on its own.

## Region capture (Select area…)

A live on-page selection, like macOS ⌘⇧4:

1. Fill in the fields and click **Select area…**. The popup closes and a
   crosshair overlay appears **on the current page** (your field values are
   remembered). Press **Esc** to cancel.
2. **Drag a rectangle** over the region you want. On release, the live page is
   captured at that moment and a **preview modal** shows the crop with
   **Confirm** / **Cancel**.
3. **Confirm** stores that region as the draft screenshot. Reopen the extension
   (its icon shows a badge): the **preview appears above the "Saving to:" path**.
4. Click **Save** (below, applies to everything captured) to write it exactly
   like a full-page shot — URL bar baked on, plus the `.md` sidecar (with any
   network/console data captured at selection time) when a description or
   mini-prompt is present — or whenever there's captured data to keep. **Discard** clears just this draft, and **Retake area** starts a new
   selection in its place.

**Take full page** stays available at all times, so you never have to make a
selection when you just want the whole viewport — it also fills the draft and is
written only when you click **Save**.

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
grid of previews, each tagged with whether it has details / network / console
data.

- The page opens on the popup's current **subfolder**; you can type a different
  subfolder in the header bar and hit **Load** (or Enter) to browse elsewhere
  under the same base folder, and **Refresh** to re-scan.
- **Click any card** to open the editor: a large preview beside the editable
  fields (URL, issue description, mini-prompt). **Save** rewrites the `.md`
  sidecar in place — any captured `## Network` / `## Console` section is
  preserved untouched, and clearing all fields removes the sidecar (unless it
  still holds captured data). **Delete reference** removes the
  screenshot *and* its `.md` sidecar together (after a confirmation).
- The first time the page opens after a browser restart it asks you to **Grant
  folder access** (Chrome re-confirming read/write to the chosen folder).

Editing round-trips reliably thanks to a small `<!-- stf-meta: … -->` block
appended to each sidecar — invisible in rendered Markdown, authoritative when the
editor re-opens the file. For a multi-screenshot sidecar (see
[Multiple screenshots per issue](#multiple-screenshots-per-issue)), editing text
here preserves every image it already references — but the gallery pairs each
`.png` with a same-named `.md`, so only the *first* image of the set gets a
"details" tag; the rest still show up (documented in the shared sidecar, just
without their own badge here).

The popup and the references page share their code (`lib.js`) and the same stored
base-folder handle, so no re-picking is needed.

## Settings runs in its own tab

Like the references page, **⚙️ Settings** opens as a real browser tab
(`settings.html`), not a view inside the popup. This isn't just consistency for
its own sake — it fixes a real cross-platform bug:

Choosing a base folder calls `window.showDirectoryPicker()`, which opens the
OS's **native** folder dialog. A Chrome extension **popup closes the instant it
loses focus** (that's also why [region capture](#region-capture-select-area)
needs a background worker). On macOS, the native picker behaves like an
attached sheet and doesn't blur the invoking popup — so keeping "Settings"
inside the popup happened to work there. On Linux (GTK's file chooser is a
separate top-level window), opening the picker **does** blur the popup, Chrome
closes it immediately, and the whole `await window.showDirectoryPicker()` call
gets abandoned mid-flight — the folder you picked is silently lost, and the
field never updates. A plain tab doesn't have this failure mode, so the picker
now works the same way on every platform.

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
