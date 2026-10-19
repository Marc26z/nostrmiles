# 🛣️ Mileage

A **trip log with an end-to-end encrypted Nostr backup** that runs entirely in
the browser — a PWA you can install, and an APK you can sideload. Log trips by
odometer reading, tag them business or personal, and watch the deduction
estimate at the IRS rate.

Purple on black by default, with a light variant behind the theme toggle.

## How the backup works

Everything lives in `localStorage` until you back up. When you do, the whole
log (`{ trips, rate }`) is serialized to JSON and encrypted with **NIP-44**
under a conversation key you have **with your own key**, then published as the
content of a kind `30078` ([NIP-78] app data) addressable event tagged
`d="mileage"`. Relays only ever see ciphertext.

Restore fetches your newest such event and decrypts it. There is no server, no
account and no database — an `nsec` and a relay are all it takes.

```
log ── JSON ── NIP-44(you ↔ you) ──► relay      (kind 30078, d=mileage)
log ◄─ JSON ◄─ decrypt ───────────── relay      (newest created_at wins)
```

### Same log as the widget

This format is byte-compatible with the **Mileage omalauncher widget**
(`~/.config/omalauncher/widgets/100-mileage.owl`), which shells out to
`~/.local/share/mileage/nostr.mjs`. Save the same `nsec` in both (the widget
keeps its copy at `~/.config/mileage/nsec`) and the phone's home screen and
this app read each other's backups. Trips carry Unix-second timestamps, just
like the widget's `clock` source.

## Using it

- **create a new key** or paste an existing `nsec1…` — it stays in this
  browser's `localStorage`.
- Fill in **odometer start / end**, pick **business** or **personal**, add an
  optional note, **add trip**. Deletion needs two taps.
- The **rate** slider sets the deduction rate (default `$0.67/mi`).
- **back up** / **restore** publish and fetch your encrypted log on the relay
  (default `wss://relay.primal.net`). Flip **manual** to **auto** to back up
  automatically a moment after each change.

## Files

| file | purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | the app (no build step needed at runtime) |
| `src/core.js` | trips, totals, the widget's wire format, NIP-44 events (pure, unit-tested) |
| `src/vendor.js` → `vendor/nostr.js` | `nostr-tools` bundled into one self-contained file |
| `test/` | Node tests: format/crypto round-trips **and** a jsdom smoke test of the whole app over a mocked relay |
| `manifest.webmanifest`, `sw.js`, `icons/` | installable PWA with an offline app shell |
| `scripts/build-apk.sh` | wrap the web app into an APK with `zapstore/goapk` |

## Development

Requires Node (for the bundler/tests) and Perl (for the dev server).

```sh
npm install          # nostr-tools + esbuild + jsdom
npm run build        # rebuild vendor/nostr.js after changing src/
npm test             # core tests + headless app smoke test
npm run serve        # http://localhost:8000
```

`vendor/nostr.js` is committed, so the deployed site needs no build step.

## Deploying the web app

It is a static site. Publish the repo with GitHub Pages (branch `main`, root)
or any static host. `.nojekyll` is included so asset paths are served as-is.

## Publishing to Zapstore

The APK is wrapped with [`zapstore/goapk`](https://github.com/zapstore/goapk),
which needs no Android SDK, JDK or Gradle.

```sh
go install github.com/zapstore/goapk@latest
./scripts/build-apk.sh          # -> dist/mileage.apk, keystore.p12 created once
```

Reuse the same `keystore.p12` for every release so devices update in place, and
attach `dist/mileage.apk` to a GitHub release when publishing.

## Protocol notes

- Backup events are kind `30078` ([NIP-78]) with `d=mileage`, so there is one
  live version per author.
- Content: NIP-44 v2, conversation key of your key with itself.
- Payload: `{"trips":[{"t":…,"start":…,"end":…,"biz":…,"note":"…"}],"rate":…}`
  — `t` is Unix seconds; refused over 60 KB before encryption, same guard the
  widget uses.

[NIP-78]: https://github.com/nostr-protocol/nips/blob/master/78.md

## License

MIT
