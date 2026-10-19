/* =========================================================================
 * Mileage — trip log with an end-to-end encrypted Nostr backup.
 *
 * Everything is local (localStorage) until you back up: the log is NIP-44
 * encrypted under your own key and published as a kind 30078 event tagged
 * d=mileage — the same event the omalauncher widget writes, so both read
 * each other's backups.
 * ========================================================================= */

import {
  DEFAULT_RATE,
  DEFAULT_RELAY,
  D_TAG,
  KIND,
  addTrip,
  decodeSecret,
  emptyData,
  encodeSecret,
  hexToNpub,
  makeBackupEvent,
  newIdentity,
  parseBackupEvent,
  parseReading,
  pickBackupEvent,
  pubkeyOf,
  removeTrip,
  sanitizeData,
  shortNpub,
  totals,
} from "./src/core.js";
import { SimplePool } from "./vendor/nostr.js";

/* ------------------------------- helpers -------------------------------- */

const $ = (s) => document.querySelector(s);

const store = {
  get(key, def = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : v;
    } catch {
      return def;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

function loadData() {
  try {
    const raw = store.get("ml_data");
    return raw ? sanitizeData(JSON.parse(raw)) : emptyData();
  } catch {
    return emptyData();
  }
}

function saveData() {
  store.set("ml_data", JSON.stringify({ trips: state.data.trips, rate: state.data.rate }));
}

function fmtMiles(n) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtMoney(n) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(sec) {
  const ms = sec < 1e12 ? sec * 1000 : sec;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + " timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/* -------------------------------- state --------------------------------- */

const state = {
  data: loadData(),
  sk: store.get("ml_sk"),
  relay: store.get("ml_relay") || DEFAULT_RELAY,
  auto: store.get("ml_auto") === "1",
  armed: null,
  biz: true,
  backupBusy: false,
};

const pool = new SimplePool();
let autoTimer = null;
let booted = false;

function saveKey() {
  if (state.sk) store.set("ml_sk", state.sk);
  else store.del("ml_sk");
}

/* ------------------------------- chrome --------------------------------- */

function setConn(status, text) {
  const el = $("#conn-status");
  if (!el) return;
  el.dataset.state = status;
  $("#conn-text").textContent = text;
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function syncMsg(text) {
  const el = $("#sync-msg");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  store.set("ml_theme", next);
  syncThemeBtn();
}

function syncThemeBtn() {
  const btn = $("#theme-btn");
  if (!btn) return;
  const light = document.documentElement.getAttribute("data-theme") === "light";
  btn.querySelector(".theme-icon").textContent = light ? "☀️" : "🌙";
}

/* -------------------------------- render -------------------------------- */

function renderStats() {
  const { total, bizMiles, deduction } = totals(state.data);
  $("#stat-total").textContent = `${fmtMiles(total)} mi`;
  $("#stat-business").textContent = `${fmtMiles(bizMiles)} mi`;
  $("#stat-deduction").textContent = `$${fmtMoney(deduction)}`;
  $("#rate-slider").value = String(Math.round(state.data.rate * 100));
  $("#rate-value").textContent = `$${fmtMoney(state.data.rate)}/mi`;
}

function renderPreview() {
  const s = parseReading($("#start-input").value);
  const e = parseReading($("#end-input").value);
  const el = $("#dist-preview");
  if (s !== null && e !== null && e > s) {
    el.textContent = `${fmtMiles(e - s)} mi`;
    el.classList.add("on");
  } else {
    el.textContent = "enter readings";
    el.classList.remove("on");
  }
}

function renderTrips() {
  const list = $("#trips-list");
  list.textContent = "";
  const trips = state.data.trips;
  $("#trips-count").textContent = String(trips.length);
  $("#trips-empty").hidden = trips.length > 0;

  trips.forEach((trip, i) => {
    const li = document.createElement("li");
    li.className = "trip";

    const date = document.createElement("span");
    date.className = "trip-date";
    date.textContent = fmtDate(trip.t);

    const miles = document.createElement("span");
    miles.className = "trip-miles";
    miles.textContent = fmtMiles(trip.end - trip.start);

    const info = document.createElement("div");
    info.className = "trip-info";
    const kind = document.createElement("div");
    kind.className = "trip-kind" + (trip.biz ? " biz" : "");
    kind.textContent = trip.biz ? "business" : "personal";
    info.appendChild(kind);
    if (trip.note) {
      const note = document.createElement("div");
      note.className = "trip-note";
      note.textContent = trip.note;
      info.appendChild(note);
    }

    const del = document.createElement("button");
    const armed = state.armed === i;
    del.type = "button";
    del.className = "trip-del" + (armed ? " armed" : "");
    del.textContent = armed ? "delete" : "✕";
    del.setAttribute("aria-label", armed ? "Confirm delete" : "Delete trip");
    del.addEventListener("click", () => {
      if (state.armed === i) {
        state.data = removeTrip(state.data, i);
        state.armed = null;
        commit();
        toast("trip deleted");
      } else {
        state.armed = i;
        renderTrips();
        setTimeout(() => {
          if (state.armed === i) {
            state.armed = null;
            renderTrips();
          }
        }, 3000);
      }
    });

    li.append(date, miles, info, del);
    list.appendChild(li);
  });
}

function renderKey() {
  const has = !!state.sk;
  $("#key-none").hidden = has;
  $("#key-have").hidden = !has;
  $("#ident-btn").hidden = !has;
  if (has) {
    const npub = hexToNpub(pubkeyOf(state.sk));
    $("#key-npub").textContent = npub;
    $("#ident-npub").textContent = shortNpub(npub, 14, 4);
    $("#key-npub").title = npub;
  } else {
    $("#key-npub").textContent = "";
  }
  $("#relay-input").value = state.relay;
  const auto = $("#auto-btn");
  auto.classList.toggle("on", state.auto);
  auto.setAttribute("aria-pressed", String(state.auto));
  auto.textContent = state.auto ? "auto" : "manual";
}

function renderAll() {
  renderStats();
  renderTrips();
  renderKey();
}

/* ------------------------------- mutation ------------------------------- */

function commit() {
  state.armed = null;
  saveData();
  renderAll();
  scheduleAutoBackup();
}

function scheduleAutoBackup() {
  if (!state.auto || !state.sk) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    doBackup({ quiet: true }).catch(() => {});
  }, 1200);
}

/* -------------------------------- backup -------------------------------- */

async function doBackup({ quiet = false } = {}) {
  if (state.backupBusy) return;
  if (!state.sk) {
    syncMsg("save a key first — backups are addressed to your own key");
    return;
  }
  state.backupBusy = true;
  setConn("connecting", "connecting…");
  try {
    const ev = makeBackupEvent(state.sk, state.data);
    await withTimeout(Promise.all(pool.publish([state.relay], ev)), 9000, "relay");
    const count = state.data.trips.length;
    const host = (() => {
      try {
        return new URL(state.relay).host;
      } catch {
        return state.relay;
      }
    })();
    const message = `backed up ${count} trip${count === 1 ? "" : "s"} to ${host}`;
    setConn("online", "online");
    if (quiet) toast(message);
    else syncMsg(message);
  } catch (e) {
    setConn("offline", "offline");
    const message = `backup failed: ${e?.message || e}`;
    if (quiet) toast(message);
    else syncMsg(message);
  } finally {
    state.backupBusy = false;
  }
}

async function doRestore() {
  if (state.backupBusy) return;
  if (!state.sk) {
    syncMsg("save a key first — backups are addressed to your own key");
    return;
  }
  state.backupBusy = true;
  setConn("connecting", "connecting…");
  syncMsg("restoring…");
  try {
    const events = await withTimeout(
      pool.querySync([state.relay], { kinds: [KIND], authors: [pubkeyOf(state.sk)], "#d": [D_TAG], limit: 1 }),
      9000,
      "relay",
    );
    const best = pickBackupEvent(events);
    if (!best) {
      setConn("online", "online");
      syncMsg("no backup found on this relay");
      return;
    }
    state.data = parseBackupEvent(best, state.sk);
    state.armed = null;
    saveData();
    renderAll();
    const count = state.data.trips.length;
    setConn("online", "online");
    syncMsg(`restored ${count} trip${count === 1 ? "" : "s"}`);
  } catch (e) {
    setConn("offline", "offline");
    syncMsg(`restore failed: ${e?.message || e}`);
  } finally {
    state.backupBusy = false;
  }
}

function setKey(hex, message) {
  state.sk = hex;
  saveKey();
  renderKey();
  syncMsg(message);
}

/* --------------------------------- ui ----------------------------------- */

function bindUI() {
  $("#trip-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const result = addTrip(state.data, {
      start: $("#start-input").value,
      end: $("#end-input").value,
      biz: state.biz,
      note: $("#note-input").value,
    });
    const error = $("#form-error");
    if (result.error) {
      error.textContent = result.error;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    state.data = result.data;
    $("#start-input").value = "";
    $("#end-input").value = "";
    $("#note-input").value = "";
    commit();
    renderPreview();
    toast("trip added");
  });

  for (const id of ["#start-input", "#end-input"]) {
    $(id).addEventListener("input", renderPreview);
  }

  $("#biz-btn").addEventListener("click", () => {
    state.biz = !state.biz;
    const btn = $("#biz-btn");
    btn.textContent = state.biz ? "business" : "personal";
    btn.classList.toggle("on", state.biz);
    btn.setAttribute("aria-pressed", String(state.biz));
  });

  $("#rate-slider").addEventListener("input", (e) => {
    state.data = { ...state.data, rate: Number(e.target.value) / 100 };
    renderStats();
    saveData();
    scheduleAutoBackup();
  });

  $("#nsec-save").addEventListener("click", () => {
    const error = $("#key-error");
    try {
      const hex = decodeSecret($("#nsec-input").value);
      $("#nsec-input").value = "";
      error.hidden = true;
      setKey(hex, "key saved — it stays on this device");
      toast("key saved");
    } catch (e) {
      error.textContent = e?.message || String(e);
      error.hidden = false;
    }
  });

  $("#gen-key-btn").addEventListener("click", () => {
    const id = newIdentity();
    setKey(id.sk, "new key created");
    $("#key-new").hidden = false;
    $("#new-nsec").textContent = encodeSecret(id.sk);
    $("#key-error").hidden = true;
  });

  $("#copy-nsec").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#new-nsec").textContent);
      toast("secret key copied");
    } catch {
      toast("copy failed — select the text instead");
    }
  });

  $("#key-change").addEventListener("click", () => {
    state.sk = null;
    saveKey();
    $("#key-new").hidden = true;
    renderKey();
    syncMsg("key removed from this device — backups stay on the relay");
  });

  $("#relay-input").addEventListener("change", (e) => {
    const value = e.target.value.trim() || DEFAULT_RELAY;
    state.relay = value;
    store.set("ml_relay", value);
    renderKey();
  });

  $("#backup-btn").addEventListener("click", () => {
    syncMsg("");
    doBackup();
  });
  $("#restore-btn").addEventListener("click", () => doRestore());

  $("#auto-btn").addEventListener("click", () => {
    state.auto = !state.auto;
    store.set("ml_auto", state.auto ? "1" : "0");
    renderKey();
    if (state.auto) scheduleAutoBackup();
    else clearTimeout(autoTimer);
  });

  $("#ident-btn").addEventListener("click", () => {
    $("#key-have").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  $("#theme-btn").addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
  });
}

function boot() {
  if (booted) return;
  booted = true;
  bindUI();
  // The inline <script> normally sets this before first paint; do it again in
  // case it was blocked or the page was restored from bfcache.
  applyTheme(store.get("ml_theme") === "light" ? "light" : "dark");
  renderAll();
  renderPreview();
  setConn("idle", "local");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);
