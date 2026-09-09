"use strict";

/* ------------------------------------------------------------------ *
 * Console recorder.
 *
 * Runs in the page's MAIN world at document_start (see manifest) because
 * that is the only place console.* can be wrapped before the page starts
 * logging — a normal (isolated-world) content script has its own console
 * and would see nothing the page writes.
 *
 * It keeps a capped ring buffer on `window.__stfConsole`; the popup reads
 * it with chrome.scripting.executeScript({ world: "MAIN" }) at capture
 * time. Nothing is sent anywhere on its own.
 *
 * Because this only starts recording at document_start, tabs that were
 * already open when the extension was installed/reloaded have no buffer at
 * all — the popup detects that (undefined, not empty) and tells the user to
 * reload the page.
 * ------------------------------------------------------------------ */
(function () {
  if (window.__stfConsole) return; // already installed (e.g. re-injection)

  const MAX_ENTRIES = 500;
  const MAX_TEXT = 2000;
  const buffer = [];
  window.__stfConsole = buffer;

  function fmt(v) {
    try {
      if (typeof v === "string") return v;
      if (v instanceof Error) return v.stack || v.name + ": " + v.message;
      if (v === undefined) return "undefined";
      if (v === null) return "null";
      if (typeof v === "function") return "ƒ " + (v.name || "anonymous");
      if (typeof v === "object") {
        const seen = new WeakSet();
        return JSON.stringify(v, (k, val) => {
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          return val;
        });
      }
      return String(v);
    } catch (e) {
      return "[unserializable]";
    }
  }

  function push(level, args) {
    try {
      let text = Array.prototype.map.call(args, fmt).join(" ");
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "… [truncated]";
      buffer.push({ level, ts: Date.now(), text });
      if (buffer.length > MAX_ENTRIES) buffer.shift();
    } catch (e) {
      /* recording must never break the page */
    }
  }

  ["log", "info", "warn", "error", "debug"].forEach((level) => {
    const original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      push(level, arguments);
      return original.apply(console, arguments);
    };
  });

  // Uncaught errors and rejections never reach console.* via the wrapper
  // above (the browser prints them itself), so record them separately.
  window.addEventListener(
    "error",
    (e) => {
      const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
      push("error", ["Uncaught " + fmt(e.error || e.message) + where]);
    },
    true
  );

  window.addEventListener(
    "unhandledrejection",
    (e) => push("error", ["Unhandled promise rejection: " + fmt(e.reason)]),
    true
  );
})();
