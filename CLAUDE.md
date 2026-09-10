# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A static **GitHub Pages** site (`perfectnip.github.io`, also reachable via `jimmyq-r-g.github.io`). One giant `index.html` hub links out to games, tools, unblockers, an in-page AI chat, and a GoGuardian-detection cloak. There is **no build step** — anything that runs in the browser ships as-is.

- **Owner:** `@jimmyqrg` (site owner — bypasses premium / unlimited features across all linked repos).
- **Production deploy:** branch `gh-pages`. **Commit only to `main`**; the owner pulls to `gh-pages` after verifying.
- **Backend for auth + cloud saves:** the separate `chat/` repo, deployed at `https://discord.jimmyqrg.com`.
- **AI chat proxy:** `cloudflare-worker/` (DeepSeek).
- **Sister repos mentioned by DEVELOPERS.md:** `chat/`, `../u/` (absolute unlinewize), `../q/`-style games live in a sibling `jg/g/` repo.

## Persistent agent memory

**`agent.md` at the repo root is the long-lived memory file.** It records task histories, gotchas, and per-game fixes. Update it before any chat-context compaction and re-read it when resuming. Do not delete or restructure it.

## High-level architecture

```
index.html            ← the hub. ~300KB / 5k+ lines. Game/app registry lives here.
                      All entries are base64-encoded via `_()` (decode with atob()).
                      Includes _D1.._D5 arrays for games, apps, unblocks, contacts, etc.

q/                    ← games hosted on this repo (each game is a folder with index.html)
q/e/, q/u/            ← other features routed off the hub

js/                   ← runtime browser scripts AND one-shot build/migration .mjs scripts
  jqrg-cloud.js       ← localStorage hijacker; syncs every write to discord.jimmyqrg.com
  jqrg-auth-ui.js     ← top-bar account button + sign-in/sign-up modal
  jqrg-gate.js        ← proxy detection; blocks the site if loaded through Ultraviolet/Scramjet/etc.
  jqrg-content-gate.js← reads auth state from localStorage; sets data-authed + __jqrgIsAuthed
  jqrg-particles.js   ← homepage background particles (5 styles × 4 quality tiers)
  jqrg-loader-lines.js← loading-screen tip pool
  openGame.js         ← window.openGame(url, sourcePage?) → loadGameInPage()
  panicKey.js         ← AltRight hotkey → panic URL (default: pausd.schoology.com)
  cursor.js           ← custom cursor renderer
  mainPageCloak.js    ← disguises non-game tab title/favicon (Gmail by default)
  gg-detect.js        ← GoGuardian extension detection → shows schoology-overlay.html
  ban-enforce.js      ← blocks specific emails/usernames, redirects to /tools/lagger/
  jqrg-aichat.js      ← floating AI chat widget (streams via cloudflare-worker/)
  educational-context.js ← JSON-LD decoy for AI scrapers (does not affect runtime)
  *.mjs               ← Node-only build/migration scripts (inject-cloud, migrate-loader-*,
                        audit-loader, strip-ads, fix-loader-newline, update-inject)

cloudflare-worker/    ← DeepSeek proxy. Allowed origins: perfectnip.github.io, jchat.fly.dev,
                        unlinewize.jimmyqrg.com, etc. See worker.js → ALLOWED_ORIGINS.

schoology-overlay.html ← 5.3MB fullscreen cloak shown when GoGuardian is detected
sw.js                 ← service worker (cache versioned `app-v{N}`)
css/                  ← main.css, info.css, tools.css, aichat.css
tools/                ← in-repo utilities (IndexedDB-reader, html-tester, lagger, …)
game-images/          ← game thumbnails (games/ and collections/)
cloak-images/         ← tab-cloak icons
loader/               ← loader assets
admin/                ← admin pages
api/                  ← static API stubs
about/, info/, learn/, join/, lx/, o/, strategies/, suggest-games/, html/, py/, IndexedDB-reader/
                      ← various feature sub-sites
67.html, nostalgia.html, schoology-overlay.html
                      ← standalone single-page apps
```

## Cloud saves / auth (most common integration)

Every same-origin HTML page is auth-gated. Both scripts are injected via a marker that build scripts can rewrite:

```html
<!-- JQRG_CLOUD_INJECT_BEGIN -->
<script src="/js/jqrg-cloud.js" defer></script>
<script src="/js/jqrg-auth-ui.js" defer></script>
<!-- JQRG_CLOUD_INJECT_END -->
```

After load, the global `JqrgCloud` exposes: `isLoggedIn / getUser / login / register / logout / forceSync / exportAll / importAll / deleteAll / snapshotIdb / restoreIdb / skipKey / skipKeys`.

- **New HTML page?** Run `node js/inject-cloud.mjs` (don't hand-add the tags).
- **Changed which scripts ship in the inject block?** Update `js/inject-cloud.mjs` then run `node js/update-inject.mjs`.
- **Skipped pages:** `/403.html`, `/404.html`, `/404-safe.html`, `/404-building.html`.

Backend API (in `chat/` repo) uses `?origin=jimmyqrg` on `/api/saves*`. See `DEVELOPERS.md` for full routes.

## Games

Two locations:
- **`q/g/`** (this repo) — 137+ game folders, each its own `index.html` with the inlined `__JqrgLoaderLoaded` IIFE in `<head>`.
- **`../jg/g/`** (sibling repo) — additional game packs.

Each game HTML contains its **own inlined** loader splash — there is no shared `/js/jqrg-loader.js` runtime anymore. Engine families: Unity, Ruffle (Flash), EmulatorJS, TurboWarp-packaged Scratch, plain HTML. When adding a game, copy a working shell from the same engine family.

Adding a game:
1. Drop files into the appropriate `g/` folder (this repo or sibling `jg/g/`).
2. Drop a thumbnail into `game-images/games/<name>.png` (or `game-images/collections/`). The `_()`-encoded entry in `index.html` references this filename.
3. Add the entry to `index.html`'s `_D1` array (base64 via `_()`).
4. Run `node js/audit-loader.mjs` to confirm the new page has the loader IIFE.
5. Run `node js/strip-ads.mjs --dry-run` then without `--dry-run` to drop known ad-network `<script>` tags.

## index.html encoding rules (obfuscation-lint enforced)

The `.github/workflows/obfuscation-lint.yml` workflow fails the build if `index.html` contains plaintext game data:

```
img:"|url:"|GAMES =|APPS =|UNBLOCKS =|CONTACTS =
```

→ Use the `_()` wrapper (base64) for new entries, decode with `atob()` at runtime. Don't try to "clean up" encoded blobs into plaintext.

## Local dev

```bash
# Static site (this repo)
python3 -m http.server 5830

# Backend (separate chat/ repo)
DATA_DIR=/tmp/jchat-smoke PORT=5831 ALLOW_IFRAME=true COOKIE_INSECURE=true \
  NODE_ENV=development node server/index.js

# Point the client at the local backend by adding to <head> of the page you're testing:
# <meta name="jqrg-cloud-server" content="http://127.0.0.1:5831">
# <meta name="jqrg-aichat-worker"  content="...">   # for the AI chat widget
```

No test runner, no linter beyond the obfuscation-lint workflow, no bundler. `python3 -m http.server` is enough.

## Critical gotchas

- **Commit to `main` only.** The owner manually syncs to `gh-pages` after review.
- **Never run `git checkout <file>` on files with uncommitted local edits** — it silently destroys them. Confirm first. (Documented in `agent.md`; lost work on `round-and-wound/index.html` once already.)
- **Loader is per-page, not shared.** Don't reintroduce `/js/jqrg-loader.js`; engine-specific tweaks would regress other games.
- **`</script>` inside JS string literals must be escaped as `<\/script>`** (and the matching opening `<script src=…>` as `<\\script src=…>`). HTML parser sees them as real script-tag boundaries otherwise. Real tags in `<head>` stay normal.
- **`DEVELOPERS.md` is partly stale** — it still says games live in `jg/g/`; they actually live in `q/g/` (this repo) plus `../jg/g/` (sibling repo).
- **Disk pressure** on this machine: `/System/Volumes/Data` runs near 100%; `/private/tmp/claude-*/` errors with `ENOSPC` when full. Don't dump large artifacts to `/tmp`.
- **Forbidden words in `js/*.js`** (workflow warns, not fails): `unblock|bypass|circumvent|proxy` — except in `bot-shield.js` and `educational-context.js`.
- **`schoology-overlay.html` is 5.3MB** — don't Read it whole. Use Grep with line numbers.
- **`67.html` is 4.6MB** — same caution.
- **`index.html` is 300KB / ~5k lines** — use Grep/Grep with offsets, not full reads.
- **Site owner (`@jimmyqrg`) bypasses premium limits** across all linked repos; this is intentional, not a security issue.