/* =========================================================================
 * Mileage — pure logic: trip bookkeeping, the wire format shared with the
 * omalauncher widget, and NIP-44 backup events. No DOM, no I/O.
 *
 * The backup format is byte-compatible with the widget's nostr.mjs:
 * kind 30078, tag `d=mileage`, content = NIP-44 encrypt of
 * JSON.stringify({ trips, rate }) under a conversation key the author has
 * with their own key. Restore takes the newest event by created_at.
 * ========================================================================= */

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19,
  nip44,
} from "../vendor/nostr.js";

export const KIND = 30078;
export const D_TAG = "mileage";
export const DEFAULT_RELAY = "wss://relay.primal.net";
export const DEFAULT_RATE = 0.67;
export const MAX_DATA_CHARS = 60000; // same 60 KB guard the widget uses

/* ------------------------------ bytes/hex ------------------------------- */

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/* ------------------------------- identity ------------------------------- */

export function newIdentity() {
  const sk = bytesToHex(generateSecretKey());
  return { sk, pk: getPublicKey(hexToBytes(sk)) };
}

/** Accepts nsec1… or a 64-char hex secret; returns hex. */
export function decodeSecret(input) {
  const text = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  const r = nip19.decode(text);
  if (r.type !== "nsec") throw new Error("not an nsec key");
  return bytesToHex(r.data);
}

export function encodeSecret(skHex) {
  return nip19.nsecEncode(hexToBytes(skHex));
}

export function hexToNpub(pkHex) {
  return nip19.npubEncode(pkHex);
}

export function npubToHex(npub) {
  const r = nip19.decode(String(npub || "").trim());
  if (r.type !== "npub") throw new Error("not an npub");
  // nostr-tools hands back a hex string for npub/note, raw bytes for nsec.
  return typeof r.data === "string" ? r.data : bytesToHex(r.data);
}

export function shortNpub(npub, head = 12, tail = 4) {
  const s = String(npub || "");
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function pubkeyOf(skHex) {
  return getPublicKey(hexToBytes(skHex));
}

/* -------------------------------- trips --------------------------------- */

export function emptyData() {
  return { trips: [], rate: DEFAULT_RATE };
}

/** Parse an odometer reading. Returns null when it is not a usable number. */
export function parseReading(text) {
  const s = String(text ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function distance(trip) {
  return trip.end - trip.start;
}

export function totals(data) {
  let total = 0;
  let bizMiles = 0;
  for (const t of data.trips) {
    const d = distance(t);
    total += d;
    if (t.biz) bizMiles += d;
  }
  return { total, bizMiles, deduction: bizMiles * data.rate };
}

/**
 * Add a trip, mirroring the widget's rule: start >= 0 and end > start.
 * Returns { data } with a fresh array, or { error }.
 */
export function addTrip(data, { start, end, biz = true, note = "", t = nowSec() }) {
  const s = parseReading(start);
  const e = parseReading(end);
  if (s === null || e === null || s < 0 || e <= s) {
    return { error: "enter readings — end must be greater than start" };
  }
  const trip = { t, start: s, end: e, biz: !!biz, note: String(note || "").trim() };
  return { data: { ...data, trips: [trip, ...data.trips] } };
}

export function removeTrip(data, index) {
  if (!Number.isInteger(index) || index < 0 || index >= data.trips.length) return data;
  const trips = data.trips.slice();
  trips.splice(index, 1);
  return { ...data, trips };
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/* ------------------------- wire format (widget) -------------------------- */

function sanitizeTrip(raw) {
  if (!raw || typeof raw !== "object") return null;
  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const t = Number(raw.t);
  return {
    t: Number.isFinite(t) && t > 0 ? t : nowSec(),
    start,
    end,
    biz: !!raw.biz,
    note: typeof raw.note === "string" ? raw.note : "",
  };
}

/** Coerce anything that came off a relay (or storage) into a data object. */
export function sanitizeData(raw) {
  const out = emptyData();
  if (!raw || typeof raw !== "object") return out;
  if (Array.isArray(raw.trips)) out.trips = raw.trips.map(sanitizeTrip).filter(Boolean);
  const rate = Number(raw.rate);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 10) out.rate = rate;
  return out;
}

/** Same source-of-truth serialization the widget sends. */
export function serialize(data) {
  return JSON.stringify({ trips: data.trips, rate: data.rate });
}

/** Encrypt a backup event addressed to your own key (what nostr.mjs does). */
export function makeBackupEvent(skHex, data) {
  const payload = serialize(data);
  if (payload.length > MAX_DATA_CHARS) throw new Error("log too large to encrypt (60 KB max)");
  const sk = hexToBytes(skHex);
  const pk = getPublicKey(sk);
  const ck = nip44.getConversationKey(sk, pk);
  return finalizeEvent(
    {
      kind: KIND,
      created_at: nowSec(),
      tags: [["d", D_TAG]],
      content: nip44.encrypt(payload, ck),
    },
    sk,
  );
}

/** Decrypt + sanitize. Throws on the wrong key, kind or tag. */
export function parseBackupEvent(ev, skHex) {
  if (!ev || typeof ev !== "object") throw new Error("no event");
  if (ev.kind !== KIND) throw new Error("not a mileage backup event");
  if (!(ev.tags || []).some((t) => t[0] === "d" && t[1] === D_TAG)) throw new Error("wrong d tag");
  const sk = hexToBytes(skHex);
  const pk = getPublicKey(sk);
  if (ev.pubkey !== pk) throw new Error("backup belongs to a different key");
  const ck = nip44.getConversationKey(sk, pk);
  let json;
  try {
    json = nip44.decrypt(ev.content, ck);
  } catch (e) {
    throw new Error("could not decrypt backup: " + (e?.message || e));
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("backup is not valid JSON");
  }
  return sanitizeData(parsed);
}

/** Newest matching event, like the widget's restore. */
export function pickBackupEvent(events) {
  let best = null;
  for (const ev of events || []) {
    if (!ev || ev.kind !== KIND) continue;
    if (!(ev.tags || []).some((t) => t[0] === "d" && t[1] === D_TAG)) continue;
    if (!best || ev.created_at > best.created_at) best = ev;
  }
  return best;
}
