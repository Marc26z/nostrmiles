import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KIND,
  D_TAG,
  DEFAULT_RATE,
  addTrip,
  removeTrip,
  sanitizeData,
  serialize,
  parseReading,
  totals,
  makeBackupEvent,
  parseBackupEvent,
  pickBackupEvent,
  decodeSecret,
  encodeSecret,
  hexToNpub,
  npubToHex,
  pubkeyOf,
  newIdentity,
  shortNpub,
} from "../src/core.js";
import { getPublicKey, finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import * as nip19 from "nostr-tools/nip19";

const bytesToHex = (b) => Buffer.from(b).toString("hex");
const hexToBytes = (h) => Buffer.from(h, "hex");

function logWith(...trips) {
  let data = { trips: [], rate: DEFAULT_RATE };
  for (const t of trips) data = addTrip(data, t).data;
  return data;
}

test("trip validation follows the widget's odometer rules", () => {
  let data = { trips: [], rate: DEFAULT_RATE };

  assert.ok(addTrip(data, { start: "100", end: "115" }).data, "normal reading accepted");
  assert.ok(addTrip(data, { start: "0", end: "12" }).data, "a fresh odometer (start 0) accepted");
  assert.match(addTrip(data, { start: "100", end: "100" }).error, /greater than start/);
  assert.match(addTrip(data, { start: "abc", end: "12" }).error, /greater than start/);
  assert.match(addTrip(data, { start: "", end: "12" }).error, /greater than start/);
  assert.match(addTrip(data, { start: "-5", end: "12" }).error, /greater than start/);
  assert.match(addTrip(data, { start: "100", end: "90" }).error, /greater than start/);

  assert.equal(parseReading(" 123.5 "), 123.5);
  assert.equal(parseReading("nope"), null);
  assert.equal(parseReading(""), null);

  const trip = addTrip(data, { start: "10", end: "30", biz: false, note: " home " }).data.trips[0];
  assert.equal(trip.start, 10);
  assert.equal(trip.end, 30);
  assert.equal(trip.biz, false);
  assert.equal(trip.note, "home");
  assert.ok(Math.abs(trip.t - Math.floor(Date.now() / 1000)) < 5, "t is Unix seconds like the widget's clock");
});

test("totals add up and the deduction uses the rate", () => {
  const data = logWith(
    { start: "100", end: "130", biz: true }, // 30 business
    { start: "200", end: "225", biz: false }, // 25 personal
    { start: "300", end: "310", biz: true }, // 10 business
  );
  data.rate = 0.7;
  const t = totals(data);
  assert.equal(t.total, 65);
  assert.equal(t.bizMiles, 40);
  assert.equal(t.deduction, 28);
});

test("removeTrip drops only the indexed trip", () => {
  const data = logWith({ start: "0", end: "10" }, { start: "10", end: "25" });
  assert.deepEqual(
    data.trips.map((t) => t.start),
    [10, 0],
    "newest trip is first, like the widget",
  );
  const after = removeTrip(data, 0);
  assert.equal(after.trips.length, 1);
  assert.equal(after.trips[0].start, 0);
  assert.equal(removeTrip(data, 5), data, "out of range is a no-op");
  assert.equal(removeTrip(data, -1), data);
});

test("the wire format is the widget's { trips, rate } JSON", () => {
  const data = logWith({ start: "100", end: "115.5", biz: true, note: "site visit" });
  const parsed = JSON.parse(serialize(data));
  assert.deepEqual(Object.keys(parsed).sort(), ["rate", "trips"]);
  const [trip] = parsed.trips;
  assert.deepEqual(Object.keys(trip).sort(), ["biz", "end", "note", "start", "t"]);
  assert.equal(trip.start, 100);
  assert.equal(trip.end, 115.5);
  assert.equal(trip.biz, true);
  assert.equal(trip.note, "site visit");
});

test("sanitizeData tolerates junk and keeps valid widget trips", () => {
  const dirty = {
    rate: "not a number",
    trips: [
      { t: 1700000000, start: 10, end: 20, biz: 1, note: "ok" },
      { start: 20, end: 10 }, // end < start
      { start: "x", end: 20 },
      null,
      "nonsense",
    ],
    extra: "ignored",
  };
  const clean = sanitizeData(dirty);
  assert.equal(clean.rate, DEFAULT_RATE, "bad rate falls back to the default");
  assert.equal(clean.trips.length, 1);
  assert.equal(clean.trips[0].biz, true, "truthy biz becomes a boolean");
  assert.equal(clean.trips[0].t, 1700000000);
  assert.equal(sanitizeData({ rate: 0.7, trips: [] }).rate, 0.7, "a sane rate is kept");
});

test("backup events are kind 30078 tagged d=mileage and self-addressed", () => {
  const id = newIdentity();
  const data = logWith({ start: "0", end: "42" });
  const ev = makeBackupEvent(id.sk, data);
  assert.equal(ev.kind, KIND);
  assert.deepEqual(ev.tags, [["d", D_TAG]]);
  assert.equal(ev.pubkey, getPublicKey(hexToBytes(id.sk)));
  assert.ok(ev.created_at > 1700000000);
  assert.notEqual(ev.content, serialize(data), "content is ciphertext");
});

test("a backup written exactly like nostr.mjs restores in the app", () => {
  // Mirrors ~/.local/share/mileage/nostr.mjs backup(): parseNsec → conversation
  // key with the author's own pubkey → nip44.encrypt of the widget's JSON.
  const sk = generateSecretKey();
  const payload = JSON.stringify({
    trips: [{ t: 1729000000, start: 1200, end: 1248.5, biz: true, note: "client visit" }],
    rate: 0.67,
  });
  const ck = nip44.getConversationKey(sk, getPublicKey(sk));
  const ev = finalizeEvent(
    {
      kind: KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", D_TAG]],
      content: nip44.encrypt(payload, ck),
    },
    sk,
  );

  const data = parseBackupEvent(ev, bytesToHex(sk));
  assert.equal(data.trips.length, 1);
  assert.equal(data.trips[0].start, 1200);
  assert.equal(data.trips[0].end, 1248.5);
  assert.equal(data.trips[0].note, "client visit");
  assert.equal(data.rate, 0.67);
});

test("a backup written by the app decrypts the way nostr.mjs restore does", () => {
  const id = newIdentity();
  const data = logWith({ start: "500", end: "560", biz: true }, { start: "560", end: "575", biz: false });
  const ev = makeBackupEvent(id.sk, data);

  const sk = hexToBytes(id.sk);
  const ck = nip44.getConversationKey(sk, getPublicKey(sk));
  const restored = JSON.parse(nip44.decrypt(ev.content, ck));
  assert.equal(restored.trips.length, 2);
  assert.deepEqual(
    restored.trips.map((t) => t.end - t.start),
    [15, 60],
    "trips come back newest-first as the widget stores them",
  );
  assert.equal(restored.rate, DEFAULT_RATE);
});

test("the wrong key cannot decrypt a backup", () => {
  const mine = newIdentity();
  const thief = newIdentity();
  const ev = makeBackupEvent(mine.sk, logWith({ start: "0", end: "10" }));
  assert.throws(() => parseBackupEvent(ev, thief.sk), /could not decrypt|different key/);
});

test("parseBackupEvent rejects foreign kinds and tags", () => {
  const id = newIdentity();
  const good = makeBackupEvent(id.sk, logWith({ start: "0", end: "10" }));
  assert.throws(() => parseBackupEvent({ ...good, kind: 1 }, id.sk), /not a mileage backup/);
  assert.throws(() => parseBackupEvent({ ...good, tags: [["d", "other"]] }, id.sk), /wrong d tag/);
  assert.throws(() => parseBackupEvent(null, id.sk), /no event/);
});

test("pickBackupEvent takes the newest matching event", () => {
  const id = newIdentity();
  const older = makeBackupEvent(id.sk, logWith({ start: "0", end: "10" }));
  const newer = { ...makeBackupEvent(id.sk, logWith({ start: "0", end: "99" })), created_at: older.created_at + 60 };
  const unrelated = { ...newer, kind: 1 };
  assert.equal(pickBackupEvent([older, unrelated, newer]), newer);
  assert.equal(pickBackupEvent([]), null);
  assert.equal(pickBackupEvent(null), null);
});

test("oversized logs are refused before encryption", () => {
  const id = newIdentity();
  const data = logWith({ start: "0", end: "10", note: "x".repeat(70000) });
  assert.throws(() => makeBackupEvent(id.sk, data), /too large/);
});

test("nsec / npub / hex round-trip", () => {
  const id = newIdentity();
  assert.match(id.sk, /^[0-9a-f]{64}$/);
  const nsec = encodeSecret(id.sk);
  assert.match(nsec, /^nsec1/);
  assert.equal(decodeSecret(nsec), id.sk);
  assert.equal(decodeSecret(id.sk.toUpperCase()), id.sk, "hex is accepted too");
  assert.throws(() => decodeSecret(hexToNpub(id.pk)), /not an nsec/);
  assert.throws(() => decodeSecret("nsec1notavalidkey"), /./);

  const npub = hexToNpub(id.pk);
  assert.match(npub, /^npub1/);
  assert.equal(npubToHex(npub), id.pk);
  assert.equal(pubkeyOf(id.sk), id.pk);
  assert.ok(shortNpub(npub).includes("…"));
  assert.throws(() => npubToHex("not-an-npub"), /./);
  assert.equal(npubToHex(nip19.npubEncode(id.pk)), id.pk, "core and raw nip19 agree");
});
