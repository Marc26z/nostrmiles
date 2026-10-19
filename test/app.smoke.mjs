/* Headless smoke test: loads index.html in jsdom, stubs WebSockets, then
 * creates a key, logs trips, publishes a backup, deletes a trip and restores
 * it again — the whole round trip through a mocked relay.
 *
 * WebSocket must be stubbed *before* app.js is imported, because nostr-tools
 * captures the global WebSocket at module-load time — hence the dynamic
 * import below. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

const sockets = [];
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 1);
  }
  send(data) {
    this.sent.push(data);
    // Acknowledge published events so pool.publish() resolves, like a real relay.
    try {
      const m = JSON.parse(data);
      if (m[0] === "EVENT" && m[1]?.id) setTimeout(() => this.emit(["OK", m[1].id, true, ""]), 1);
    } catch (_) {}
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for " + what);
    await tick(10);
  }
}

function setGlobal(name, value) {
  try {
    globalThis[name] = value;
  } catch (_) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

function installGlobals(window) {
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    crypto: webcrypto,
    WebSocket: MockWebSocket,
  })) {
    setGlobal(name, value);
  }
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

function closeSockets() {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch (_) {}
  }
}

function submit(window, selector) {
  window.document
    .querySelector(selector)
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

function fill(window, selector, value) {
  const el = window.document.querySelector(selector);
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const text = (window, selector) => window.document.querySelector(selector).textContent;
const hidden = (window, selector) => window.document.querySelector(selector).hidden;

test("mileage app logs trips, backs up over Nostr and restores them", async () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://mileage.test/", pretendToBeVisual: true });
  const { window } = dom;
  installGlobals(window);
  sockets.length = 0;

  // Track intervals the app starts, so the process can exit cleanly.
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const id = realSetInterval(...args);
    intervals.push(id);
    return id;
  };

  try {
    await import("../app.js");
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await tick(30);

    // --- empty state ------------------------------------------------------
    assert.equal(text(window, "#stat-total"), "0.0 mi");
    assert.equal(text(window, "#stat-business"), "0.0 mi");
    assert.equal(text(window, "#stat-deduction"), "$0.00");
    assert.equal(text(window, "#rate-value"), "$0.67/mi", "widget's default rate");
    assert.equal(text(window, "#trips-count"), "0");
    assert.equal(hidden(window, "#trips-empty"), false, "empty hint shown");
    assert.equal(hidden(window, "#key-none"), false, "asked for a key");
    assert.equal(hidden(window, "#key-have"), true);
    assert.equal(text(window, "#conn-text"), "local");
    assert.equal(hidden(window, "#sync-msg"), true);

    // --- create a key -----------------------------------------------------
    window.document.querySelector("#gen-key-btn").click();
    await tick();
    assert.equal(hidden(window, "#key-have"), false);
    assert.equal(hidden(window, "#key-new"), false, "the nsec is offered for copying");
    assert.match(text(window, "#new-nsec"), /^nsec1/);
    assert.equal(hidden(window, "#ident-btn"), false, "header shows the identity");
    assert.match(text(window, "#ident-npub"), /^npub1.*….*$/);
    const skHex = window.localStorage.getItem("ml_sk");
    assert.match(skHex, /^[0-9a-f]{64}$/);

    // --- log two trips ----------------------------------------------------
    fill(window, "#start-input", "100");
    fill(window, "#end-input", "115");
    assert.equal(text(window, "#dist-preview"), "15.0 mi", "live distance preview");
    submit(window, "#trip-form");
    await tick();
    assert.equal(text(window, "#trips-count"), "1");
    assert.equal(text(window, "#stat-total"), "15.0 mi");
    assert.equal(text(window, "#stat-business"), "15.0 mi", "business by default");
    assert.equal(text(window, "#stat-deduction"), "$10.05", "15 × 0.67");
    assert.equal(text(window, "#start-input"), "", "the form resets");

    // A personal trip counts towards the total but not the deduction.
    window.document.querySelector("#biz-btn").click();
    assert.equal(text(window, "#biz-btn"), "personal");
    fill(window, "#start-input", "200");
    fill(window, "#end-input", "225");
    fill(window, "#note-input", "grocery run");
    submit(window, "#trip-form");
    await tick();
    assert.equal(text(window, "#trips-count"), "2");
    assert.equal(text(window, "#stat-total"), "40.0 mi");
    assert.equal(text(window, "#stat-business"), "15.0 mi");
    assert.match(text(window, "#trips-list"), /grocery run/);

    // Invalid readings are refused with a visible error.
    fill(window, "#start-input", "500");
    fill(window, "#end-input", "400");
    submit(window, "#trip-form");
    await tick();
    assert.equal(hidden(window, "#form-error"), false);
    assert.equal(text(window, "#trips-count"), "2");
    fill(window, "#start-input", "");
    fill(window, "#end-input", "");
    window.document.querySelector("#form-error").hidden = true;

    // --- rate slider ------------------------------------------------------
    const slider = window.document.querySelector("#rate-slider");
    slider.value = "70";
    slider.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
    assert.equal(text(window, "#rate-value"), "$0.70/mi");
    assert.equal(text(window, "#stat-deduction"), "$10.50");

    // --- back it up -------------------------------------------------------
    window.document.querySelector("#backup-btn").click();
    await until(
      () => sockets.some((s) => s.sent.some((m) => m.startsWith('["EVENT"'))),
      "the backup EVENT",
    );
    await until(() => !hidden(window, "#sync-msg") && !text(window, "#sync-msg").includes("restor"), "sync message");

    const outbound = sockets
      .flatMap((s) => s.sent)
      .map((m) => JSON.parse(m))
      .filter((m) => m[0] === "EVENT")
      .map((m) => m[1]);
    assert.equal(outbound.length, 1, "exactly one event published");
    const ev = outbound[0];
    assert.equal(ev.kind, 30078);
    assert.deepEqual(ev.tags, [["d", "mileage"]]);
    assert.match(text(window, "#sync-msg"), /^backed up 2 trips to relay\.primal\.net$/);
    assert.equal(window.document.querySelector("#conn-status").dataset.state, "online");

    // The ciphertext decrypts the way nostr.mjs restore() would do it.
    const sk = Uint8Array.from(Buffer.from(skHex, "hex"));
    const ck = nip44.getConversationKey(sk, getPublicKey(sk));
    const payload = JSON.parse(nip44.decrypt(ev.content, ck));
    assert.equal(payload.trips.length, 2);
    assert.equal(payload.rate, 0.7);
    assert.deepEqual(
      payload.trips.map((t) => t.end - t.start),
      [25, 15],
      "newest trip first, like the widget",
    );

    // --- delete a trip ----------------------------------------------------
    const del = window.document.querySelector(".trip-del");
    del.click();
    await tick();
    assert.equal(window.document.querySelector(".trip-del").textContent, "delete", "first tap arms the delete");
    window.document.querySelector(".trip-del").click();
    await tick();
    assert.equal(text(window, "#trips-count"), "1");
    assert.equal(text(window, "#stat-total"), "15.0 mi", "only the business trip remains");
    const local = JSON.parse(window.localStorage.getItem("ml_data"));
    assert.equal(local.trips.length, 1);

    // --- restore it from the relay ---------------------------------------
    window.document.querySelector("#restore-btn").click();
    await until(
      () =>
        sockets.some((s) =>
          s.sent.some((m) => {
            try {
              return JSON.parse(m)[0] === "REQ";
            } catch {
              return false;
            }
          }),
        ),
      "the restore REQ",
    );
    const reqSocket = sockets.find((s) =>
      s.sent.some((m) => {
        try {
          return JSON.parse(m)[0] === "REQ";
        } catch {
          return false;
        }
      }),
    );
    const reqId = reqSocket.sent.map((m) => JSON.parse(m)).find((m) => m[0] === "REQ")[1];
    reqSocket.emit(["EVENT", reqId, ev]);
    reqSocket.emit(["EOSE", reqId]);
    await until(() => text(window, "#sync-msg") === "restored 2 trips", "restore message");

    assert.equal(text(window, "#trips-count"), "2");
    assert.equal(text(window, "#stat-total"), "40.0 mi");
    assert.equal(text(window, "#stat-deduction"), "$10.50");
    assert.equal(JSON.parse(window.localStorage.getItem("ml_data")).trips.length, 2);

    // --- theme toggle -----------------------------------------------------
    assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
    window.document.querySelector("#theme-btn").click();
    await tick();
    assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
    assert.equal(window.localStorage.getItem("ml_theme"), "light");
    window.document.querySelector("#theme-btn").click();
    await tick();
    assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");

    // --- the log survives a reload without the relay ----------------------
    const stored = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      stored[k] = window.localStorage.getItem(k);
    }

    const dom2 = new JSDOM(html, { url: "https://mileage.test/", pretendToBeVisual: true });
    installGlobals(dom2.window);
    for (const [k, v] of Object.entries(stored)) dom2.window.localStorage.setItem(k, v);
    sockets.length = 0;
    await import(`../app.js?persist=${Date.now()}`);
    dom2.window.document.dispatchEvent(new dom2.window.Event("DOMContentLoaded"));
    await tick(30);

    try {
      assert.equal(text(dom2.window, "#trips-count"), "2", "trips reappear after a reload");
      assert.equal(text(dom2.window, "#stat-total"), "40.0 mi");
      assert.equal(dom2.window.document.querySelector("#conn-text").textContent, "local");
      assert.ok(
        !sockets.some((s) => s.sent.some((m) => m.startsWith('["EVENT"'))),
        "nothing is published on its own — backups stay manual",
      );
    } finally {
      closeSockets();
      dom2.window.close();
    }
  } finally {
    closeSockets();
    globalThis.setInterval = realSetInterval;
    for (const id of intervals) clearInterval(id);
    dom.window.close();
  }
});
