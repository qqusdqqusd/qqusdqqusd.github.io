# Developers Read This

## Cloud Saves & Sign-in (`js/jqrg-cloud.js` + `js/jqrg-auth-ui.js`)

All same-origin pages on `perfectnip.github.io` are auth-gated and sync game progress to the chat backend (`chat.jimmyqrg.com`). Each HTML file pulls in two scripts via the shared inject marker:

```html
<!-- JQRG_CLOUD_INJECT_BEGIN -->
<script src="/js/jqrg-cloud.js" defer></script>
<script src="/js/jqrg-auth-ui.js" defer></script>
<!-- JQRG_CLOUD_INJECT_END -->
```

### How it works
- `jqrg-cloud.js` hijacks `localStorage` and syncs every write to the server, debounced. It also snapshots IndexedDB for Unity WebGL / Construct games (`snapshotIdb` / `restoreIdb` / `autoSyncIdb`), auto-detecting those engines.
- On first login, any existing local data is bulk-uploaded to the server, then the merged set is pulled back — last-writer-wins per key. Accounts that have no server data keep their local progress (nothing is lost).
- `jqrg-auth-ui.js` adds the account button to the top bar and drives the sign-in / sign-up / account modal.
- The account modal now exposes:
  - **Sync now** – flushes pending writes and pulls the latest server data.
  - **Export data** – downloads a JSON snapshot of every save (localStorage + idb).
  - **Import data** – uploads a previously exported (or equivalent) JSON file.
  - **Delete all data** – confirm dialog that requires typing `DELETE` before wiping both server saves and local storage (the account itself is kept).
  - **Sign out** – revokes the current token.
- Pages `/403.html`, `/404.html`, `/404-safe.html`, `/404-building.html` are skipped by the gate. Anything else blocks the user with a non-dismissible modal until they sign in or sign up.

### Key JS APIs

```js
// Browser globals (after jqrg-cloud.js loads)
JqrgCloud.isLoggedIn() / getUser()
JqrgCloud.login(username, password) / JqrgCloud.register({ username, email, password, display_name })
JqrgCloud.logout()
JqrgCloud.forceSync()                  // flush pending writes + pull latest
JqrgCloud.exportAll()                  // -> { format, items: [...] }
JqrgCloud.importAll(data)              // data = { items: [...] } or plain {key:value}
JqrgCloud.deleteAll()                  // wipes server saves + synced local keys
JqrgCloud.snapshotIdb() / restoreIdb() // manual IndexedDB sync for Unity etc.
JqrgCloud.skipKey('prefix_') / skipKeys(['a_','b_']) // opt keys out of sync
```

### Server-side

The backend lives in the separate repo `chat/` (deployed at `https://chat.jimmyqrg.com`). It exposes the user/saves APIs used by the client:

- `POST /api/auth/register` / `POST /api/auth/login` – returns a bearer token when called from an off-origin client.
- `GET /api/auth/me` – current session user.
- `GET /api/saves?origin=jimmyqrg[&kind=…][&since=…]` – list saves.
- `PUT /api/saves` / `POST /api/saves/bulk` – single or bulk upsert.
- `DELETE /api/saves?origin=jimmyqrg[&kind=…][&key=…|all=1]` – delete a key or wipe an origin.
- `GET /api/saves/stats?origin=jimmyqrg` – key / byte counts.
- `POST /api/auth/sso` / `GET /api/auth/sso?sso=TOKEN` – exchange a token for a cookie session (used when opening chat from the main site).

CORS, cookies and CSP `frame-ancestors` are configured for `perfectnip.github.io` and the local dev origins. Account data, tokens and saves are all stored on the same SQLite DB as chat, so existing accounts are preserved.

### Local development

```bash
# In the chat/ repo:
DATA_DIR=/tmp/jchat-smoke PORT=5831 ALLOW_IFRAME=true COOKIE_INSECURE=true \
  NODE_ENV=development node server/index.js

# In this repo (serves the static site):
python3 -m http.server 5830
```

Point the client at the local server by adding this to an HTML page when testing:

```html
<meta name="jqrg-cloud-server" content="http://127.0.0.1:5831">
```

### Adding the scripts to new HTML pages

The helper `js/inject-cloud.mjs` walks the repo and injects both script tags into any HTML that doesn't have the marker yet. Run `node js/inject-cloud.mjs` after adding a new page. If the payload between the markers needs to change across every file, update it in `inject-cloud.mjs` and run `node js/update-inject.mjs` to rewrite every existing injection.

### Opting a key out of sync

Some keys (e.g. giant ephemeral caches) shouldn't sync. Add them at runtime via `JqrgCloud.skipKey('my_cache_')`, or contribute a permanent entry to the `SKIP_PREFIXES` array in `js/jqrg-cloud.js`.

## Games

Game files are located in folder `jg/g/`

### Loading screens architecture

- There is no shared `/js/jqrg-loader.js` runtime anymore.
- Each game HTML entry now contains an inlined loading-screen script in `<head>`.
- When adding a new game page, copy a working game shell from the same engine family
  (Unity / Ruffle / EmulatorJS / plain HTML), then adjust game-specific progress hooks.
- Do not re-introduce `<script src=\"/js/jqrg-loader.js\"></script>`; keep loader logic local
  to the page so engine-specific tweaks do not regress unrelated games.

Game images are located in folder `game-images/games/` or `game-images/collections/`

> To add a game, you can look at the layout of the games in `./index.html`.
> 
> You need both game file and game image to add a game.
> 
> _ALT_ value is __required__ to display the text on a game image.

## Javascript code

All site scripts live in `js/`. They split into two groups:

1. **Runtime scripts** — loaded by HTML pages via `<script src="/js/…">`.
2. **Build / migration scripts** — Node.js (`.mjs`) tools you run from the repo root with `node js/<name>.mjs`. They never ship to the browser.

### Runtime scripts

| File | Purpose |
| --- | --- |
| `cursor.js` | Custom cursor renderer + 20-frame animated cursor cycle. Reads `localStorage` to enable/disable and pick assets from the `/cursor/` folder. |
| `educational-context.js` | Injects Schema.org `EducationalOrganization` JSON-LD plus dummy "digital literacy curriculum" metadata. It's an AI / content-filter decoy — it does not change behavior, only what scrapers see. |
| `jqrg-auth-ui.js` | Top-bar account button, sign-in / sign-up / account modal, and the `ensureTopBarButton()` placement logic. Loaded everywhere via the cloud-inject markers. |
| `jqrg-cloud.js` | The `JqrgCloud` global. Hijacks `localStorage` to sync writes to `chat.jimmyqrg.com`, snapshots IndexedDB for Unity / Construct games, and exposes `forceSync` / `exportAll` / `importAll` / `deleteAll`. See the **Cloud Saves & Sign-in** section above. |
| `jqrg-loader-lines.js` | Auto-generated array of loading-screen tip / fact lines exposed as `window.__JqrgLoaderLines`. Regenerated from `py/lines.py`; the same payload is also inlined into every game HTML by `migrate-loader-tip-lines-inline.mjs` so the lines paint immediately. |
| `jqrg-particles.js` | Homepage background particle system. Five styles (`constellation`, `nebula`, `aurora`, `quantum`, `crystal`, plus `none`) and four quality tiers. Public API: `window.JqrgParticles.{setStyle, setQuality, getStyle, getQuality, refresh, STYLES, QUALITIES, …}`. Settings persist in `localStorage`. |
| `mainPageCloak.js` | Disguises the **non-game** pages' tab title + favicon (default: `Inbox - Gmail`). Reads `mainPageCloak`, `mainCloakTitle`, `mainCloakIcon` from `localStorage`; rewrites `*.png` cloak paths to the matching `cloak-images/favicon/*.ico`. Skips any URL under `/q/g/`. |
| `openGame.js` | Defines `window.openGame(url, sourcePage?)`, which forwards to `loadGameInPage()` (defined in `index.html`). Also strips the "a midgame ad will appear here" overlays some embedded games inject. |
| `panicKey.js` | Panic-redirect hotkey. Defaults to `AltRight` (the legacy `ShiftRight` value is auto-migrated). Destination URL comes from `localStorage.panicKeyLink` and falls back to `pausd.schoology.com`. Both the key and the URL are configurable from the homepage settings. |
| `jqrg-aichat.js` | On-page assistant. Floating chat opened from the second home-quick-card. Streams responses from a Cloudflare Worker proxy (`cloudflare-worker/`) that holds the DeepSeek key. Features: markdown + KaTeX + code highlighting; Standard / Reasoning model switch with auto-routing; per-device escalating rate limit (5/30/60/180/1440 min bans); file upload (text + images); chat history synced to account via `JqrgCloud`; access-code easter egg. Worker URL is set via `<meta name="jqrg-aichat-worker">` in the page head. |

#### AI helper deployment

The chat module ships disabled until the Cloudflare Worker is deployed. To
turn it on:

1. `cd cloudflare-worker && wrangler login` (one-time)
2. `wrangler secret put DEEPSEEK_KEY` and paste a key from
   <https://platform.deepseek.com/api_keys>
3. `wrangler deploy`
4. Copy the printed worker URL into the
   `<meta name="jqrg-aichat-worker" content="...">` tag in `index.html`.

See `cloudflare-worker/README.md` for full instructions, optional KV-backed
server-side rate limiting, and local dev notes.

#### Loading the cloud / auth pair

Don't add `<script src="/js/jqrg-cloud.js">` or `<script src="/js/jqrg-auth-ui.js">` by hand. Use the marker comments and run `node js/inject-cloud.mjs`:

```html
<!-- JQRG_CLOUD_INJECT_BEGIN -->
<script src="/js/jqrg-cloud.js" defer></script>
<script src="/js/jqrg-auth-ui.js" defer></script>
<!-- JQRG_CLOUD_INJECT_END -->
```

#### `openGame.js` usage

```html
<script src="/js/openGame.js"></script>
<button onclick="openGame('https://www.example.com')">CLICK ME</button>
```

#### Loader splash (per-game, inline)

There is **no shared `/js/jqrg-loader.js` runtime any more**. Every game HTML inlines the universal loader IIFE inside its `<head>`. To audit which game pages are missing it, run:

```bash
node js/audit-loader.mjs
```

To roll a new loader change out across all game HTML, edit the canonical copy (e.g. in `slope/index.html`), then use `migrate-loader-*.mjs` helpers to propagate the change.

### Build / migration scripts (Node.js, `js/*.mjs`)

These scripts mutate the repo and are run manually after a code change. They're idempotent — re-running on an already-updated tree is a no-op.

| File | What it does |
| --- | --- |
| `audit-loader.mjs` | Walk every `*.html` under `jg/` and report any game page whose `<head>` is missing the inlined `__JqrgLoaderLoaded` IIFE. Useful before publishing new pages. |
| `inject-cloud.mjs` | Insert the `JQRG_CLOUD_INJECT_BEGIN/END` block + the two `<script>` tags into any HTML that doesn't already have them. Run this whenever you add a new page. |
| `update-inject.mjs` | Rewrite the payload **between** the cloud markers across every previously injected file. Use this when you change which scripts ship in the inject block (e.g. when `jqrg-auth-ui.js` was added next to `jqrg-cloud.js`). |
| `fix-loader-newline.mjs` | One-shot repair for a build accident where `].join('\n')` got serialized with a real newline (a SyntaxError). Re-runs are safe — files already correct are skipped. |
| `migrate-loader-tip-lines-inline.mjs` | Inlines `window.__JqrgLoaderLines` directly above the loader IIFE in every game page so the splash has tips ready before the lazy `/js/jqrg-loader-lines.js` fetch returns. |
| `migrate-loader-tip-footer.mjs` | Adds / refreshes the loader's footer-line rendering across every inlined loader copy. |
| `migrate-loader-soundgate.mjs` | Adds the original "click to enable sound" gate to every inlined loader. |
| `migrate-loader-sound-gate-redesign.mjs` | Replaces the legacy sound gate with the redesigned tap-to-start UI. |
| `migrate-loader-base-href-fix.mjs` | Patches game pages that ship `<base href="https://cdn…">` so their loader brand image, splash assets, and the cloud / auth scripts all resolve against the local origin instead of 404'ing on the CDN. |
| `migrate-bridd-jump-skip-splash.mjs` | Bridd Jump-specific patch: forces the loader to skip its splash on this game so its own intro can play immediately. |
| `migrate-turbowarp-jqrg.mjs` | Patch every TurboWarp-packaged Scratch game (`jg/g/<scratch-game>/`) to wire the splash + cloud markers into the TurboWarp shell. |
| `strip-ads.mjs` | Walk `jg/g/` and remove `<script>` tags that load known ad / analytics hosts (`googletagmanager.com`, `googlesyndication.com`, `cloudflareinsights.com`, `gamemonetize.com`, `imasdk.googleapis.com`). Pass `--dry-run` to preview. |

## Current Work

Pending add games list:

> ultrakill

> ultrakill 2

> don't lose now

> rotator

> fallout (first fallout game)

> Retro Bowl College

> Gladihoppers

### How to add games

1. Get the source files for the game

2. Go to folder `jg/g/`, create a folder of the game's name to contain all the game files.

3. Go to folder `game-images/games`, upload an image and name the image the same name as the game files folder.

4. Notify me so I can add the game entry in `./index.html`

## Restrictions

The page is currently deployed on branch `gh-pages` and please only write commits on main `branch`, I will pull the commits from `gh-pages` after verified.
