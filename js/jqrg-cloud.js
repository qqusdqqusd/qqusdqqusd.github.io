/* jqrg-cloud.js
 * Client for discord.jimmyqrg.com auth + per-user save sync. Dropped into every same-origin page on
 * perfectnip.github.io so games inherit cloud saves automatically. The file is idempotent and
 * safe to include multiple times.
 *
 * It exposes `window.JqrgCloud` with:
 *   - login(username, password), register({...}), logout()
 *   - getUser() / isLoggedIn() / onAuthChange(handler)
 *   - forceSync()  – flush any pending writes and pull the latest server data
 *   - skipKey(prefix) / skipKeys([...])  – keys matching these prefixes are never synced
 *   - pushSave(key, value)  – opt-in manual push for IndexedDB/Unity snapshots
 *   - snapshotIdb(names?)  – snapshot one or more IndexedDB databases to the server (Unity saves)
 *   - restoreIdb(names?)   – restore IndexedDB snapshots from the server before the game starts
 *   - autoSyncIdb(names?)  – automatically snapshot on visibility-hidden and beforeunload
 *
 * localStorage is intercepted by wrapping the global Storage prototype. Writes are batched and
 * sent to /api/saves; reads are unaffected. On sign-in the script bulk-uploads everything that
 * exists locally (one-time migration) and then bulk-downloads the server snapshot, preferring
 * the newer side per key (last-writer-wins by timestamp).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__JqrgCloudLoaded) return;
  window.__JqrgCloudLoaded = true;

  // Allow override via <meta name="jqrg-cloud-server" content="..."> or window.__JqrgCloudServer
  // so local/staging copies of the chat server can be tested without editing this file.
  var SERVER = (function () {
    try {
      if (typeof window !== 'undefined' && typeof window.__JqrgCloudServer === 'string' && window.__JqrgCloudServer) {
        return window.__JqrgCloudServer.replace(/\/+$/, '');
      }
      var meta = document.querySelector && document.querySelector('meta[name="jqrg-cloud-server"]');
      if (meta && meta.content) return meta.content.replace(/\/+$/, '');
    } catch (_) {}
    return 'https://discord.jimmyqrg.com';
  })();
  // Server-side bucket identifier. External JimmyQrg apps (e.g. mcraft.fly.dev) override this so
  // their saves don't collide with key names used on the main site. Same user account, different
  // origins on the server.
  var STORAGE_NAMESPACE = (function () {
    try {
      if (typeof window !== 'undefined' && typeof window.__JqrgCloudNamespace === 'string' && window.__JqrgCloudNamespace) {
        return window.__JqrgCloudNamespace;
      }
      var meta = document.querySelector && document.querySelector('meta[name="jqrg-cloud-namespace"]');
      if (meta && meta.content) return meta.content;
    } catch (_) {}
    return 'jimmyqrg';
  })();
  var AUTH_KEY = '__jqrg_auth_v1';
  var LAST_SYNC_KEY = '__jqrg_cloud_last_sync';
  var MIGRATION_KEY = '__jqrg_cloud_migrated_v1';
  var PENDING_KEY = '__jqrg_cloud_pending_v1';

  var BANNED_EMAILS = ['weeee@outlook.com'];
  function _isBannedEmail(email) {
    if (!email) return false;
    var e = email.toLowerCase();
    for (var i = 0; i < BANNED_EMAILS.length; i++) {
      if (BANNED_EMAILS[i] === e) return true;
    }
    return false;
  }
  function _showBanScreen() {
    if (document.getElementById('jqrg-ban-screen')) return;
    var ov = document.createElement('div');
    ov.id = 'jqrg-ban-screen';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;align-items:center;justify-content:center;flex-direction:column;';
    var h = document.createElement('h1');
    h.textContent = 'YOU ARE BANNED FROM JIMMYQRG.';
    h.style.cssText = 'color:#ff0000;font-size:3rem;font-weight:900;text-align:center;padding:0 2rem;font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.1em;';
    ov.appendChild(h);
    document.body.appendChild(ov);
  }
  // Per-key local-write timestamps. Recorded by the storage interceptor so a
  // later `pushAllLocal()` can push each key with its actual mtime instead of
  // `Date.now()` for every entry. Without this, a fresh device with stale
  // localStorage would clobber newer server data on first sync (the server's
  // last-writer-wins picks the bigger updated_at, and `Date.now()` always
  // wins). Stored separately from the pending queue because the queue is
  // cleared after a successful flush, but we need durable history of when a
  // key was last touched on this device.
  var KEY_TIMES_KEY = '__jqrg_cloud_key_times_v1';
  var DEBOUNCE_MS = 800;
  var FETCH_INTERVAL_MS = 45 * 1000;
  var MAX_VALUE_BYTES = 512 * 1024;
  var SYNC_SKIP_PREFIXES = [
    '__jqrg_auth_',
    '__jqrg_cloud_',
    '__JqrgCloud',
    '__autoclick_', // the existing auto-clicker runtime state is noisy and per-tab
  ];
  // Keys that index.html / the main shell uses for *site preferences*. These are
  // intentionally per-device (cloaking, cursor toggle, toolbar position, panic key,
  // etc.) and must never be flagged as "syncable game data" — otherwise opening the
  // site for the first time pops the "you have local data to sync" modal even though
  // the user hasn't touched a single game.
  var SYNC_SKIP_KEYS = new Set([
    'jqrg_redirect_after_login',
    'jqrg_redirect_after_signup',
    // Site cloak (home page tab + favicon disguise)
    'mainPageCloak', 'mainCloakTitle', 'mainCloakIcon',
    // Per-game cloak inside iframes
    'cloakSiteTitle', 'cloakSiteIcon', 'cloakMethod',
    // UI/UX preferences
    'enableCursor', 'gameToolbarPosition',
    // Panic-key shortcut
    'panicKey', 'panicKeyLink',
    // Misc shell preferences
    'closePreventionEnabled', 'autoAnnouncement',
    'user', // legacy authorized/normal flag for the access-code modal
    'autoClickerSettings',
    'favoriteGames', // favorites are stored per-device; no game progress here
  ]);
  var userSkipPrefixes = [];

  var LS = (function () { try { return window.localStorage; } catch (_) { return null; } })();

  /** Internal fetch that wires Authorization header + credentials. */
  var REQUEST_TIMEOUT_MS = 12000;

  function request(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (authState && authState.token) headers['Authorization'] = 'Bearer ' + authState.token;
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(SERVER + path, {
      method: opts.method || 'GET',
      credentials: 'include',
      mode: 'cors',
      headers: headers,
      body: opts.body,
      signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      var ct = res.headers.get('Content-Type') || '';
      var parse = ct.indexOf('application/json') !== -1 ? res.json() : res.text();
      return parse.then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || res.statusText || 'Request failed');
          err.status = res.status;
          err.data = data;
          if (res.status === 401) {
            clearAuth();
          }
          throw err;
        }
        return data;
      });
    });
  }

  // Keep references to the native Storage methods so our own bookkeeping writes
  // bypass the interceptor and never trigger re-entrant enqueue() calls.
  var _storageProto = LS ? (Object.getPrototypeOf(LS) || Storage.prototype) : null;
  var _origSetItem = _storageProto ? _storageProto.setItem : null;
  var _origGetItem = _storageProto ? _storageProto.getItem : null;
  var _origRemoveItem = _storageProto ? _storageProto.removeItem : null;

  function readJSON(key, fallback) {
    if (!LS) return fallback;
    try {
      var raw = _origGetItem ? _origGetItem.call(LS, key) : LS.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) { return fallback; }
  }
  function writeJSON(key, value) {
    if (!LS || !_origSetItem) return;
    try { _origSetItem.call(LS, key, JSON.stringify(value)); } catch (_) {}
  }
  function removeKey(key) {
    if (!LS || !_origRemoveItem) return;
    try { _origRemoveItem.call(LS, key); } catch (_) {}
  }

  var authState = readJSON(AUTH_KEY, null);
  if (authState && typeof authState === 'object' && authState.token && authState.user) {
    if (_isBannedEmail(authState.user.email)) {
      document.addEventListener('DOMContentLoaded', _showBanScreen);
      if (document.readyState !== 'loading') _showBanScreen();
    }
  } else {
    authState = null;
  }

  var authChangeHandlers = [];
  function fireAuthChange() {
    for (var i = 0; i < authChangeHandlers.length; i++) {
      try { authChangeHandlers[i](authState ? authState.user : null); } catch (_) {}
    }
  }

  function setAuth(user, token) {
    authState = { user: user, token: token, savedAt: Date.now() };
    writeJSON(AUTH_KEY, authState);
    fireAuthChange();
  }
  function clearAuth() {
    authState = null;
    removeKey(AUTH_KEY);
    fireAuthChange();
  }

  function shouldSyncKey(key) {
    if (typeof key !== 'string') return false;
    if (SYNC_SKIP_KEYS.has(key)) return false;
    for (var i = 0; i < SYNC_SKIP_PREFIXES.length; i++) {
      if (key.indexOf(SYNC_SKIP_PREFIXES[i]) === 0) return false;
    }
    for (var j = 0; j < userSkipPrefixes.length; j++) {
      if (key.indexOf(userSkipPrefixes[j]) === 0) return false;
    }
    return true;
  }

  var pendingQueue = readJSON(PENDING_KEY, {}) || {};
  var debounceTimer = null;
  var flushInFlight = false;
  // In-memory mirror of KEY_TIMES_KEY, persisted lazily so we don't pay a
  // synchronous JSON.stringify on every game-tick localStorage write.
  var keyTimes = readJSON(KEY_TIMES_KEY, {}) || {};
  var keyTimesDirty = false;
  var keyTimesFlushTimer = null;
  function markKeyTime(key, time) {
    var t = time || Date.now();
    if (keyTimes[key] === t) return;
    keyTimes[key] = t;
    keyTimesDirty = true;
    if (keyTimesFlushTimer) return;
    keyTimesFlushTimer = setTimeout(function () {
      keyTimesFlushTimer = null;
      if (!keyTimesDirty) return;
      writeJSON(KEY_TIMES_KEY, keyTimes);
      keyTimesDirty = false;
    }, 1500);
  }
  function clearKeyTime(key) {
    if (!(key in keyTimes)) return;
    delete keyTimes[key];
    keyTimesDirty = true;
    if (keyTimesFlushTimer) return;
    keyTimesFlushTimer = setTimeout(function () {
      keyTimesFlushTimer = null;
      if (!keyTimesDirty) return;
      writeJSON(KEY_TIMES_KEY, keyTimes);
      keyTimesDirty = false;
    }, 1500);
  }

  /** Enqueue a change for syncing (value === null means delete). Debounces writes. */
  function enqueue(key, value) {
    if (!shouldSyncKey(key)) return;
    var now = Date.now();
    pendingQueue[key] = { value: value, time: now, deleted: value === null };
    writeJSON(PENDING_KEY, pendingQueue);
    if (value === null) clearKeyTime(key);
    else markKeyTime(key, now);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      flushPending();
    }, DEBOUNCE_MS);
  }

  function flushPending() {
    if (flushInFlight) { scheduleFlush(); return; }
    if (!authState) return; // nothing to send; stay queued for after login
    var entries = Object.keys(pendingQueue);
    if (!entries.length) return;
    flushInFlight = true;
    var items = [];
    for (var i = 0; i < entries.length; i++) {
      var k = entries[i];
      var op = pendingQueue[k];
      if (op.deleted) {
        items.push({ key: k, value: '', updated_at: op.time, _delete: true });
      } else {
        var raw = op.value == null ? '' : String(op.value);
        if (raw.length > MAX_VALUE_BYTES) continue; // too big, skip silently
        items.push({ key: k, value: raw, updated_at: op.time });
      }
    }
    // Split deletes and upserts. Bulk upsert handles inserts/updates in one roundtrip; deletes are per-key.
    var deletes = items.filter(function (it) { return it._delete; });
    var upserts = items.filter(function (it) { return !it._delete; });
    var chain = Promise.resolve();
    if (upserts.length) {
      chain = chain.then(function () {
        return request('/api/saves/bulk', {
          method: 'POST',
          body: JSON.stringify({ origin: STORAGE_NAMESPACE, items: upserts }),
        });
      });
    }
    for (var d = 0; d < deletes.length; d++) {
      (function (item) {
        chain = chain.then(function () {
          var q = '?origin=' + encodeURIComponent(STORAGE_NAMESPACE) + '&key=' + encodeURIComponent(item.key);
          return request('/api/saves' + q, { method: 'DELETE' });
        });
      })(deletes[d]);
    }
    chain.then(function () {
      pendingQueue = {};
      writeJSON(PENDING_KEY, pendingQueue);
      writeJSON(LAST_SYNC_KEY, { at: Date.now() });
    }).catch(function (err) {
      // On failure leave pending in place; we'll retry next tick.
      if (err && err.status === 401) { /* not logged in */ }
    }).then(function () {
      flushInFlight = false;
    });
  }

  /** Patch localStorage so every write and removal is observed. We replace setItem / removeItem /
   *  clear on Storage.prototype so all tabs/iframes on our origin are covered. */
  function installInterceptor() {
    if (!LS || !_storageProto) return;
    if (window.__jqrg_ls_patched) return;
    window.__jqrg_ls_patched = true;
    var origSet = _origSetItem;
    var origRemove = _origRemoveItem;
    var origClear = _storageProto.clear;
    _storageProto.setItem = function (k, v) {
      var ret = origSet.apply(this, arguments);
      try { if (this === LS) enqueue(String(k), v == null ? '' : String(v)); } catch (_) {}
      return ret;
    };
    _storageProto.removeItem = function (k) {
      var ret = origRemove.apply(this, arguments);
      try { if (this === LS) enqueue(String(k), null); } catch (_) {}
      return ret;
    };
    _storageProto.clear = function () {
      var keys = [];
      try { for (var i = 0; i < LS.length; i++) keys.push(LS.key(i)); } catch (_) {}
      var ret = origClear.apply(this, arguments);
      try {
        if (this === LS) for (var j = 0; j < keys.length; j++) if (keys[j]) enqueue(keys[j], null);
      } catch (_) {}
      return ret;
    };
  }

  /** Listen for storage events so writes from other same-origin tabs/iframes also sync. */
  function installStorageListener() {
    try {
      window.addEventListener('storage', function (e) {
        if (!e || !e.key) return;
        if (!shouldSyncKey(e.key)) return;
        // e.newValue === null means removeItem/clear; anything else is the new string value.
        enqueue(e.key, e.newValue);
      });
    } catch (_) {}
  }

  /** Enumerate every local syncable key (localStorage). */
  function listLocalSyncableKeys() {
    var keys = [];
    if (!LS) return keys;
    try {
      for (var i = 0; i < LS.length; i++) {
        var k = LS.key(i);
        if (k && shouldSyncKey(k)) keys.push(k);
      }
    } catch (_) {}
    return keys;
  }

  /** True if this device has any syncable localStorage keys or IndexedDB databases. */
  function hasLocalSyncableData() {
    if (listLocalSyncableKeys().length > 0) return true;
    // IDB check is async; treat unknown-at-sync-time as "no" for the synchronous helper.
    return false;
  }

  /** Async: true if the current signed-in user hasn't pushed their local data on this device yet AND
   *  local data exists. Safe to call before or after UI interactions. Engine virtual-FS DBs
   *  (e.g. `/idbfs`, `/userfs`) only count when they have been explicitly registered through
   *  `registerGameSave()` — otherwise their presence on first run would falsely trigger the
   *  "you have unsynced data" prompt for visitors who only opened a game page once and never
   *  played, since the engine creates an empty IDBFS even before the user does anything. */
  function hasUnsyncedLocalData() {
    if (!authState) return Promise.resolve(false);
    var rec = readJSON(MIGRATION_KEY, null);
    var currentUserId = authState.user && authState.user.id;
    if (rec && rec.user === currentUserId) return Promise.resolve(false);
    // Check localStorage first (cheap) and then ask the browser about IDB databases.
    if (listLocalSyncableKeys().length > 0) return Promise.resolve(true);
    return listIdbDatabases().then(function (names) {
      var meaningful = (names || []).filter(function (n) {
        if (!n) return false;
        if (isEngineCacheName(n)) return false; // Emscripten asset cache, not save data
        if (!isVirtualFsName(n)) return true;   // ordinary IDB game = always counts
        return isRegisteredGameSave(n);         // virtual FS only counts when opted in
      });
      return meaningful.length > 0;
    }).catch(function () { return false; });
  }

  /** Async: true if the signed-in user's server account has zero saves across every kind we sync. */
  function isAccountEmpty() {
    if (!authState) return Promise.resolve(true);
    return request('/api/saves?origin=' + encodeURIComponent(STORAGE_NAMESPACE))
      .then(function (data) {
        return !data || !Array.isArray(data.items) || data.items.length === 0;
      })
      .catch(function () { return false; });
  }

  /** Push every local syncable LS entry AND every IndexedDB snapshot to the server. The server
   *  upserts with last-writer-wins semantics. Each key is pushed with its tracked local-write
   *  timestamp (falling back to migration-now when the key has no recorded mtime, e.g. it was
   *  written before this device started tracking) so newer server-side data isn't blindly
   *  overwritten by stale local copies — only keys we genuinely wrote later than the server win.
   *  Returns a summary. */
  function pushAllLocal(opts) {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    opts = opts || {};
    // Migration timestamp used as a floor for keys with no recorded mtime. Picking "now" makes
    // first-time migrations (account is empty / hasn't synced before) win, while subsequent
    // pushes still respect per-key recorded times (which override this default below).
    var migrationTs = Date.now();
    var items = [];
    try {
      for (var i = 0; i < LS.length; i++) {
        var k = LS.key(i);
        if (!k || !shouldSyncKey(k)) continue;
        var v = LS.getItem(k);
        if (v == null) continue;
        if (v.length > MAX_VALUE_BYTES) continue;
        // Use the recorded per-key write time when we have one; otherwise the keys are
        // pre-tracking-era state from this device and we treat them as freshly migrated.
        var keyTs = keyTimes[k];
        items.push({ key: k, value: v, updated_at: typeof keyTs === 'number' ? keyTs : migrationTs });
      }
    } catch (_) {}
    var chain = items.length
      ? request('/api/saves/bulk', {
          method: 'POST',
          body: JSON.stringify({ origin: STORAGE_NAMESPACE, items: items }),
        })
      : Promise.resolve({ accepted: 0, rejected: 0 });
    return chain.then(function (res) {
      // Push every IDB DB this device is willing to sync: auto-detected plus
      // anything games registered explicitly (e.g. Unity IDBFS at `/idbfs`,
      // which the auto path skips because of its leading slash).
      var snapshotPromise = snapshotIdb().catch(function () { return []; });
      var registeredPromise = registeredGameSaves.length
        ? snapshotIdb(registeredGameSaves.slice()).catch(function () { return []; })
        : Promise.resolve([]);
      return Promise.all([snapshotPromise, registeredPromise]).then(function (out) {
        var idbResults = (out[0] || []).concat(out[1] || []);
        writeJSON(MIGRATION_KEY, { at: Date.now(), user: authState.user && authState.user.id });
        return {
          localStorage: items.length,
          indexedDB: idbResults.length,
          server: res || null,
        };
      });
    });
  }

  /** Merge local data to account without deleting account data for games that only exist on account.
   *  Uses last-writer-wins semantics - only overwrites account data if local data is newer.
   *  Unlike pushAllLocal, this only processes keys that have actual local data. */
  function mergeLocalToAccount(opts) {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    opts = opts || {};
    var migrationTs = Date.now();
    var items = [];
    try {
      for (var i = 0; i < LS.length; i++) {
        var k = LS.key(i);
        if (!k || !shouldSyncKey(k)) continue;
        var v = LS.getItem(k);
        if (v == null) continue;
        if (v.length > MAX_VALUE_BYTES) continue;
        // Skip empty or whitespace-only values
        if (typeof v === 'string' && v.trim().length === 0) continue;
        var keyTs = keyTimes[k];
        items.push({ key: k, value: v, updated_at: typeof keyTs === 'number' ? keyTs : migrationTs });
      }
    } catch (_) {}
    var chain = items.length
      ? request('/api/saves/bulk', {
          method: 'POST',
          body: JSON.stringify({ origin: STORAGE_NAMESPACE, items: items }),
        })
      : Promise.resolve({ accepted: 0, rejected: 0 });
    return chain.then(function (res) {
      // Only snapshot IDB databases that have actual game save data
      // (skip empty IDB databases created by just opening a game)
      return snapshotIdbWithData().then(function (idbResults) {
        writeJSON(MIGRATION_KEY, { at: Date.now(), user: authState.user && authState.user.id });
        return {
          localStorage: items.length,
          indexedDB: idbResults.length,
          server: res || null,
        };
      }).catch(function () {
        writeJSON(MIGRATION_KEY, { at: Date.now(), user: authState.user && authState.user.id });
        return { localStorage: items.length, indexedDB: 0, server: res || null };
      });
    });
  }

  /** Snapshot IDB databases but only include those with actual game save data.
   *  Empty IDB databases (created by just opening a game without playing) are skipped. */
  function snapshotIdbWithData() {
    return listIdbDatabases().then(function (names) {
      var gameDbs = (names || []).filter(function (n) {
        if (!n) return false;
        if (isEngineCacheName(n)) return false;
        if (isVirtualFsName(n)) return false;
        // Only count databases that have actual content
        return true;
      });
      if (!gameDbs.length) return Promise.resolve([]);
      return snapshotIdb(gameDbs);
    }).catch(function () { return []; });
  }

  /** Record that the sync prompt was dismissed without uploading, so the user isn't pestered on
   *  every page load. They can still manually trigger a push later. */
  function skipLocalMigration() {
    if (!authState) return;
    writeJSON(MIGRATION_KEY, { at: Date.now(), user: authState.user && authState.user.id, skipped: true });
  }

  /** True if the current account has been marked as migrated (pushed or explicitly skipped). */
  function hasRecordedMigration() {
    if (!authState) return false;
    var rec = readJSON(MIGRATION_KEY, null);
    return !!(rec && rec.user === (authState.user && authState.user.id));
  }

  /** Fetch everything from the server newer than `since` (0 means full snapshot) and apply to localStorage. */
  function pullFromServer(since) {
    if (!authState) return Promise.resolve({ items: [] });
    var url = '/api/saves?origin=' + encodeURIComponent(STORAGE_NAMESPACE) + '&since=' + (since || 0);
    return request(url).then(function (data) {
      if (!data || !Array.isArray(data.items)) return data;
      var origSet = _origSetItem;
      for (var i = 0; i < data.items.length; i++) {
        var it = data.items[i];
        if (!it || typeof it.key !== 'string') continue;
        if (!shouldSyncKey(it.key)) continue;
        // Never restore a key that has a pending local delete or a newer local write.
        var pend = pendingQueue[it.key];
        if (pend && pend.time >= (it.updated_at || 0)) continue;
        try {
          // Write bypassing our interceptor so we don't echo back to the server.
          if (origSet) origSet.call(LS, it.key, it.value == null ? '' : String(it.value));
          else LS.setItem(it.key, it.value == null ? '' : String(it.value));
        } catch (_) {}
      }
      writeJSON(LAST_SYNC_KEY, { at: data.server_time || Date.now() });
      return data;
    });
  }

  var periodicTimer = null;
  function startPeriodicSync() {
    if (periodicTimer) return;
    periodicTimer = setInterval(function () {
      if (!authState) return;
      var last = readJSON(LAST_SYNC_KEY, null);
      var since = (last && last.at) ? last.at - 1000 : 0;
      // Flush first so our changes go up before we pull theirs.
      flushPending();
      pullFromServer(since).catch(function () {});
    }, FETCH_INTERVAL_MS);
  }
  function stopPeriodicSync() {
    if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  }

  function whoAmI() {
    return request('/api/auth/me').then(function (data) {
      if (!data || !data.user) {
        // Our token is dead; invalidate.
        if (authState) clearAuth();
        return null;
      }
      if (!authState) {
        // We have a cookie-based session but no stored token. Ask for one so games work too.
        return request('/api/auth/token', { method: 'POST', body: JSON.stringify({ label: 'main' }) })
          .then(function (t) { setAuth(data.user, t.token); return data.user; })
          .catch(function () { return data.user; });
      }
      // Refresh cached user info in case display_name/avatar changed.
      authState.user = data.user;
      writeJSON(AUTH_KEY, authState);
      return data.user;
    });
  }

  /** Try to exchange a cookie session for a bearer token if we somehow don't have one. */
  function bootstrapToken() {
    if (authState && authState.token) return Promise.resolve(authState.user);
    return whoAmI().catch(function () { return null; });
  }

  function login(usernameOrEmail, password) {
    var identifier = (usernameOrEmail || '').trim();
    if (identifier.indexOf('@') !== -1) identifier = identifier.toLowerCase();
    var loginBody = {
      // Keep legacy field for older backends.
      username: identifier,
      // Preferred explicit field for newer backends.
      identifier: identifier,
      password: password,
    };
    if (identifier.indexOf('@') !== -1) {
      // Some backend versions may read `email` explicitly.
      loginBody.email = identifier;
    }
    return request('/api/auth/login?want_token=1', {
      method: 'POST',
      body: JSON.stringify(loginBody),
    }).then(function (data) {
      if (data.error) throw new Error(data.error);
      if (!data.user || !data.token) throw new Error('Invalid login response');
      if (_isBannedEmail(data.user.email) || _isBannedEmail(identifier)) {
        _showBanScreen();
        throw new Error('YOU ARE BANNED FROM JIMMYQRG.');
      }
      setAuth(data.user, data.token);
      return pullFromServer(0).then(function () { startPeriodicSync(); return data.user; });
    });
  }

  function sendVerifyCode(email) {
    return fetch(SERVER + '/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      mode: 'cors',
      credentials: 'include',
      body: JSON.stringify({ email: email }),
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Failed'); return d; }); });
  }

  function getRecaptchaToken(action) {
    return new Promise(function (resolve) {
      if (!window.grecaptcha || !window.grecaptcha.execute) { resolve(null); return; }
      var meta = document.querySelector('meta[name="jqrg-recaptcha-sitekey"]');
      var key = (meta && meta.content) || null;
      if (!key) { resolve(null); return; }
      try {
        window.grecaptcha.ready(function () {
          window.grecaptcha.execute(key, { action: action || 'forgot_password' })
            .then(resolve).catch(function () { resolve(null); });
        });
      } catch (_) { resolve(null); }
    });
  }

  function _captchaFetch(path, body, captchaAction) {
    return getRecaptchaToken(captchaAction || 'forgot_password').then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Recaptcha-Token'] = token;
      return fetch(SERVER + path, {
        method: 'POST',
        headers: headers,
        mode: 'cors',
        credentials: 'include',
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Failed'); return d; }); });
    });
  }

  function _publicFetch(path, body) {
    return fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      mode: 'cors',
      credentials: 'include',
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Failed'); return d; }); });
  }

  function requestAccountKeyView() {
    return request('/api/auth/account-key/request-view', {
      method: 'POST',
      body: '{}',
    }).then(function (d) { if (d.error) throw new Error(d.error); return d; });
  }
  function viewAccountKey(code) {
    return request('/api/auth/account-key/view', {
      method: 'POST',
      body: JSON.stringify({ code: code }),
    }).then(function (d) { if (d.error) throw new Error(d.error); return d; });
  }

  function recoverStart(key) { return _publicFetch('/api/auth/recover/start', { key: key }); }
  function recoverEmailHint(token) { return _publicFetch('/api/auth/recover/email-hint', { recovery_token: token }); }
  function recoverSendCode(token, email) { return _publicFetch('/api/auth/recover/send-code', { recovery_token: token, email: email }); }
  function recoverComplete(token, code, newPassword) {
    var body = { recovery_token: token, new_password: newPassword };
    if (code) body.code = code;
    return _publicFetch('/api/auth/recover/complete', body);
  }
  function recoverFreeze(token) { return _publicFetch('/api/auth/recover/freeze', { recovery_token: token }); }
  function forgotPassword(identifier) { return _captchaFetch('/api/auth/forgot-password', { identifier: identifier }); }
  function reportBlockedEmail(email) { return _publicFetch('/api/auth/report-blocked-email', { email: email }); }

  function register(fields) {
    var body = {
      username: (fields.username || '').trim().toLowerCase(),
      email: (fields.email || '').trim(),
      password: fields.password || '',
      display_name: fields.display_name || fields.username || '',
    };
    if (fields.email_code) body.email_code = fields.email_code;
    if (_isBannedEmail(body.email)) {
      _showBanScreen();
      return Promise.reject(new Error('YOU ARE BANNED FROM JIMMYQRG.'));
    }
    return request('/api/auth/register?want_token=1', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(function (data) {
      if (data.error) throw new Error(data.error);
      if (!data.user || !data.token) throw new Error('Invalid register response');
      setAuth(data.user, data.token);
      var accountKey = data.account_key || null;
      return pullFromServer(0).then(function () { startPeriodicSync(); return { user: data.user, accountKey: accountKey }; });
    });
  }

  function logout() {
    var had = !!authState;
    var req = request('/api/auth/logout', { method: 'POST' }).catch(function () {});
    stopPeriodicSync();
    clearAuth();
    pendingQueue = {};
    writeJSON(PENDING_KEY, pendingQueue);
    return req.then(function () { return had; });
  }

  function forceSync() {
    if (!authState) return Promise.resolve(null);
    var last = readJSON(LAST_SYNC_KEY, null);
    var since = (last && last.at) ? last.at - 1000 : 0;
    flushPending();
    return pullFromServer(since);
  }

  function pushSave(key, value, kind) {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    if (typeof key !== 'string' || !key) return Promise.reject(new Error('key required'));
    var body = { origin: STORAGE_NAMESPACE, key: key, value: value == null ? '' : String(value), kind: kind || 'blob', updated_at: Date.now() };
    return request('/api/saves', { method: 'PUT', body: JSON.stringify(body) });
  }

  function fetchSave(key, kind) {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    var q = '?origin=' + encodeURIComponent(STORAGE_NAMESPACE) + '&key=' + encodeURIComponent(key) + '&kind=' + encodeURIComponent(kind || 'blob');
    return request('/api/saves/one' + q);
  }

  /** Pull the entire save set for the user across every kind (localStorage + idb snapshots). */
  function exportAll() {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    var kinds = ['localStorage', 'blob', IDB_KIND_PREFIX + 'default'];
    return Promise.all(kinds.map(function (kind) {
      return request('/api/saves?origin=' + encodeURIComponent(STORAGE_NAMESPACE) + '&kind=' + encodeURIComponent(kind))
        .then(function (data) { return { kind: kind, items: (data && data.items) || [] }; })
        .catch(function () { return { kind: kind, items: [] }; });
    })).then(function (buckets) {
      var items = [];
      for (var b = 0; b < buckets.length; b++) {
        for (var i = 0; i < buckets[b].items.length; i++) {
          var it = buckets[b].items[i];
          items.push({
            origin: STORAGE_NAMESPACE,
            key: it.key,
            value: it.value,
            kind: buckets[b].kind,
            updated_at: it.updated_at,
          });
        }
      }
      return {
        format: 'jqrg-cloud-export',
        version: 1,
        exported_at: Date.now(),
        user: authState && authState.user ? { id: authState.user.id, username: authState.user.username } : null,
        items: items,
      };
    });
  }

  /** Accept an export file (as produced by `exportAll`) or a flat array/object of key/value
   *  pairs and upload them to the server. Returns a summary { accepted, rejected, total }. */
  function importAll(data) {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    if (!data) return Promise.reject(new Error('Empty import payload'));
    var items = [];
    // Official export format
    if (Array.isArray(data.items)) {
      for (var i = 0; i < data.items.length; i++) {
        var it = data.items[i];
        if (!it || typeof it.key !== 'string') continue;
        items.push({ key: it.key, value: it.value == null ? '' : String(it.value), updated_at: Number(it.updated_at) || Date.now(), kind: it.kind || 'localStorage' });
      }
    } else if (Array.isArray(data)) {
      for (var j = 0; j < data.length; j++) {
        var row = data[j];
        if (!row || typeof row.key !== 'string') continue;
        items.push({ key: row.key, value: row.value == null ? '' : String(row.value), updated_at: Number(row.updated_at) || Date.now(), kind: row.kind || 'localStorage' });
      }
    } else if (typeof data === 'object') {
      // Plain key/value object – treat as a localStorage blob.
      for (var k in data) {
        if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
        items.push({ key: k, value: String(data[k] == null ? '' : data[k]), updated_at: Date.now(), kind: 'localStorage' });
      }
    }
    if (!items.length) return Promise.reject(new Error('No valid save entries found'));

    // Server's /bulk route reads kind from each item, so we just chunk items directly.
    var accepted = 0, rejected = 0, total = items.length;
    var chain = Promise.resolve();
    for (var idx = 0; idx < items.length; idx += 500) {
      (function (slice) {
        chain = chain.then(function () {
          return request('/api/saves/bulk', {
            method: 'POST',
            body: JSON.stringify({ origin: STORAGE_NAMESPACE, items: slice }),
          }).then(function (r) {
            accepted += Number(r && r.accepted) || 0;
            rejected += Number(r && r.rejected) || 0;
          });
        });
      })(items.slice(idx, idx + 500));
    }
    return chain.then(function () {
      // Mirror localStorage kind items into the live localStorage so the user sees them immediately.
      try {
        items.forEach(function (it) { if (it.kind === 'localStorage' && _origSetItem) _origSetItem.call(LS, it.key, it.value); });
      } catch (_) {}
      return { accepted: accepted, rejected: rejected, total: total };
    });
  }

  /** Wipe every save for this user (all kinds) on the server and clear synced localStorage
   *  keys locally. Does not delete the account itself. */
  function deleteAll() {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    var kinds = ['localStorage', 'blob', IDB_KIND_PREFIX + 'default'];
    var chain = Promise.resolve();
    kinds.forEach(function (kind) {
      chain = chain.then(function () {
        return request('/api/saves?origin=' + encodeURIComponent(STORAGE_NAMESPACE) + '&kind=' + encodeURIComponent(kind) + '&all=1', { method: 'DELETE' })
          .catch(function () { /* ignore individual kind failures */ });
      });
    });
    return chain.then(function () {
      // Clear same-origin localStorage except our own internal bookkeeping.
      try {
        if (LS) {
          var keys = [];
          for (var i = 0; i < LS.length; i++) keys.push(LS.key(i));
          keys.forEach(function (k) { if (shouldSyncKey(k) && _origRemoveItem) _origRemoveItem.call(LS, k); });
        }
      } catch (_) {}
      pendingQueue = {};
      writeJSON(PENDING_KEY, pendingQueue);
      writeJSON(LAST_SYNC_KEY, { at: Date.now() });
      return { ok: true };
    });
  }

  /** Wipe every syncable piece of local game data on this device without touching the
   *  server account. Used by the sync prompt's "Erase" option, where the user wants to
   *  start fresh on this device but keep whatever is already saved to their account.
   *
   *  Mirrors the same definition of "syncable" that hasUnsyncedLocalData() uses so a
   *  successful erase guarantees the next call to hasUnsyncedLocalData() returns false:
   *    - localStorage: every key passing shouldSyncKey() (skips site preferences,
   *      auth token, and our own bookkeeping prefixes).
   *    - IndexedDB: every database that hasUnsyncedLocalData() considers meaningful
   *      (skips Emscripten asset caches and unregistered virtual filesystems so we
   *      don't blow away an engine's freshly-downloaded compiled bundles).
   *
   *  Records a MIGRATION_KEY entry so the prompt does not re-fire the moment the user
   *  navigates back to the account modal. Does not require a logged-in user — wiping
   *  local data is meaningful even when signed out, but we only stamp the migration
   *  key when we have an account id to scope it to. */
  function wipeLocalSyncable() {
    var lsCleared = 0;
    try {
      if (LS && _origRemoveItem) {
        var keys = [];
        for (var i = 0; i < LS.length; i++) {
          var k = LS.key(i);
          if (k) keys.push(k);
        }
        keys.forEach(function (k) {
          if (!shouldSyncKey(k)) return;
          try { _origRemoveItem.call(LS, k); lsCleared++; } catch (_) {}
          try { delete keyTimes[k]; } catch (_) {}
        });
      }
    } catch (_) {}

    // Reset the per-key write-time map and the pending-flush queue so a sync we
    // start later doesn't replay phantom writes for keys we just removed.
    pendingQueue = {};
    try { writeJSON(PENDING_KEY, pendingQueue); } catch (_) {}
    try { writeJSON(KEY_TIMES_KEY, keyTimes); keyTimesDirty = false; } catch (_) {}

    // Stamp the migration key so the "Sync local data?" prompt accepts the user's
    // choice as a final answer for this device + account pairing. Without this stamp
    // the prompt would re-fire the next time `maybeOfferLocalSync()` runs because
    // `hasUnsyncedLocalData` would walk an empty LS and an empty IDB and find no
    // pending data — but only AFTER the IDB delete completes, which is async, and
    // we want the dismissal to take effect synchronously.
    if (authState && authState.user) {
      try {
        writeJSON(MIGRATION_KEY, {
          at: Date.now(),
          user: authState.user.id,
          erased: true,
        });
      } catch (_) {}
    }

    // IndexedDB cleanup runs after LS so the sync state is already coherent if any
    // engine code hooks the deleteDatabase events and tries to read state on unload.
    return listIdbDatabases().then(function (names) {
      var meaningful = (names || []).filter(function (n) {
        if (!n) return false;
        if (isEngineCacheName(n)) return false;
        if (!isVirtualFsName(n)) return true;
        return isRegisteredGameSave(n);
      });
      if (!meaningful.length) {
        return { ok: true, localStorage: lsCleared, indexedDB: 0 };
      }
      var deletions = meaningful.map(function (name) {
        return new Promise(function (resolve) {
          try {
            var req = indexedDB.deleteDatabase(name);
            // All three terminal states resolve so a single stuck DB never holds
            // up the rest of the wipe. `onblocked` typically fires when another
            // tab still has the DB open; in that case the delete completes once
            // the other tab navigates away, which is fine for our UX.
            req.onsuccess = function () { resolve(true); };
            req.onerror = function () { resolve(false); };
            req.onblocked = function () { resolve(false); };
          } catch (_) {
            resolve(false);
          }
        });
      });
      return Promise.all(deletions).then(function (results) {
        var deleted = results.filter(Boolean).length;
        return { ok: true, localStorage: lsCleared, indexedDB: deleted };
      });
    }).catch(function () {
      return { ok: true, localStorage: lsCleared, indexedDB: 0 };
    });
  }

  /* ============================================================================
   * IndexedDB helpers – used by Unity WebGL / Construct / Godot / etc.
   * Unity's IDBFS writes to a database named `/idbfs/<hash>` and Godot uses
   * `/userfs`. Rather than require every game to know about us, we expose a
   * generic snapshot/restore API that serialises every object store in a DB as
   * JSON (base64 for non-JSON blobs) and uploads it under kind="idb:<name>".
   * ==========================================================================*/

  var IDB_KIND_PREFIX = 'idb:';
  var IDB_SNAPSHOT_BYTES = 12 * 1024 * 1024; // hard cap per DB snapshot
  // Engine-managed virtual filesystems we should never round-trip through the
  // cloud by default. Unity IDBFS uses paths like `/idbfs/<sha1>`; Godot uses
  // `/userfs`, `/local`, etc. Snapshotting these isn't useful (they're huge
  // and engine-internal) and worse: the entries are typed objects (Uint8Array
  // contents, Date timestamps) that any JSON-based round-trip can mangle.
  // Once a DB whose name starts with "/" is skipped here, the engine keeps
  // managing its own filesystem and we leave it alone.
  //
  // Pages whose engines DO store actual save data in a virtual FS (Hollow
  // Knight, Silksong, etc.) opt back in via `registerGameSave(name)`.
  function isVirtualFsName(name) {
    return typeof name === 'string' && name.charAt(0) === '/';
  }

  // Emscripten's `EM_FS_<pathname>` databases hold the engine's compiled
  // asset cache (downloaded `.data` blobs, decompressed WebGL output, ...).
  // They can be hundreds of MB, change between page loads as caches evolve,
  // and don't contain user save data — that lives in IDBFS / virtual FS.
  // Filtering them out keeps auto-sync from churning on cache state and
  // stops `hasUnsyncedLocalData()` from flagging cache-only devices as
  // having pending uploads.
  function isEngineCacheName(name) {
    return typeof name === 'string' && name.indexOf('EM_FS_') === 0;
  }

  // Tags used when round-tripping native types through JSON. The keys start
  // with "$jqrg:" (a colon never appears in normal JS property names that have
  // a chance of ending up in a game save) so a colliding real property is
  // vanishingly unlikely.
  var TAG_DATE = '$jqrg:date';
  var TAG_U8 = '$jqrg:u8';
  var TAG_AB = '$jqrg:ab';

  // Recursively encode a value so JSON.stringify preserves Date objects and
  // typed arrays. Plain objects/arrays are walked; primitives pass through.
  // Cycle detection via a WeakSet so degenerate save shapes don't hang us.
  function deepEncode(v, seen) {
    if (v == null) return v;
    if (v instanceof Date) {
      var t = Object.create(null); t[TAG_DATE] = v.getTime(); return t;
    }
    if (v instanceof Uint8Array) {
      var u = Object.create(null); u[TAG_U8] = bufToB64(v); return u;
    }
    if (v instanceof ArrayBuffer) {
      var a = Object.create(null); a[TAG_AB] = bufToB64(new Uint8Array(v)); return a;
    }
    if (ArrayBuffer.isView && ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      // Other typed arrays: preserve as Uint8Array view of underlying buffer.
      var u2 = Object.create(null);
      u2[TAG_U8] = bufToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      return u2;
    }
    if (typeof Blob !== 'undefined' && v instanceof Blob) return null;
    if (typeof v !== 'object') return v;
    seen = seen || (typeof WeakSet !== 'undefined' ? new WeakSet() : null);
    if (seen && seen.has(v)) return null;
    if (seen) seen.add(v);
    if (Array.isArray(v)) {
      var arr = new Array(v.length);
      for (var i = 0; i < v.length; i++) arr[i] = deepEncode(v[i], seen);
      return arr;
    }
    var out = {};
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        out[k] = deepEncode(v[k], seen);
      }
    }
    return out;
  }

  // Inverse of deepEncode: rebuild Date/Uint8Array/ArrayBuffer instances from
  // their tagged shells. Untagged plain objects/arrays/primitives pass through.
  function deepDecode(v) {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    if (typeof v[TAG_DATE] === 'number') return new Date(v[TAG_DATE]);
    if (typeof v[TAG_U8] === 'string') return b64ToBuf(v[TAG_U8]);
    if (typeof v[TAG_AB] === 'string') return b64ToBuf(v[TAG_AB]).buffer;
    if (Array.isArray(v)) {
      var arr = new Array(v.length);
      for (var i = 0; i < v.length; i++) arr[i] = deepDecode(v[i]);
      return arr;
    }
    var out = {};
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        out[k] = deepDecode(v[k]);
      }
    }
    return out;
  }

  function encodeValue(v) {
    if (v == null) return { t: 'null' };
    if (v instanceof Uint8Array) return { t: 'u8', d: bufToB64(v) };
    if (v instanceof ArrayBuffer) return { t: 'ab', d: bufToB64(new Uint8Array(v)) };
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      // Blobs need async read; caller converts ahead of time.
      return { t: 'blob', d: null };
    }
    try {
      return { t: 'j', d: deepEncode(v) };
    } catch (_) {
      return { t: 'skip' };
    }
  }
  function decodeValue(enc) {
    if (!enc || typeof enc !== 'object') return null;
    if (enc.t === 'u8') return b64ToBuf(enc.d);
    if (enc.t === 'ab') return b64ToBuf(enc.d).buffer;
    if (enc.t === 'j') return deepDecode(enc.d);
    if (enc.t === 'null') return null;
    return null;
  }
  function bufToB64(u8) {
    try {
      var s = '';
      var len = u8.length;
      for (var i = 0; i < len; i += 0x8000) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      }
      return btoa(s);
    } catch (_) { return ''; }
  }
  function b64ToBuf(str) {
    try {
      var bin = atob(str || '');
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    } catch (_) { return new Uint8Array(); }
  }

  function openDb(name) {
    return new Promise(function (resolve, reject) {
      try {
        var req = indexedDB.open(name);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('open failed')); };
        req.onblocked = function () { reject(new Error('blocked')); };
      } catch (err) { reject(err); }
    });
  }

  function listIdbDatabases() {
    try {
      if (indexedDB && typeof indexedDB.databases === 'function') {
        return indexedDB.databases().then(function (list) {
          return (list || []).map(function (d) { return d && d.name ? d.name : null; }).filter(Boolean);
        });
      }
    } catch (_) {}
    return Promise.resolve([]);
  }

  function snapshotOne(name) {
    return openDb(name).then(function (db) {
      return new Promise(function (resolve, reject) {
        var stores = Array.from(db.objectStoreNames || []);
        if (!stores.length) { db.close(); return resolve({ name: name, version: db.version, stores: {} }); }
        var tx;
        try { tx = db.transaction(stores, 'readonly'); }
        catch (err) { db.close(); return reject(err); }
        var out = { name: name, version: db.version, stores: {} };
        var pending = stores.length;
        stores.forEach(function (s) {
          out.stores[s] = { keyPath: null, autoInc: false, entries: [] };
          var store;
          try { store = tx.objectStore(s); } catch (_) { if (!--pending) done(); return; }
          out.stores[s].keyPath = store.keyPath;
          out.stores[s].autoInc = !!store.autoIncrement;
          var cursorReq = store.openCursor();
          cursorReq.onerror = function () { if (!--pending) done(); };
          cursorReq.onsuccess = function () {
            var c = cursorReq.result;
            if (!c) { if (!--pending) done(); return; }
            try {
              var entry = { k: (store.keyPath ? null : c.key), v: encodeValue(c.value) };
              if (entry.v && entry.v.t !== 'skip' && entry.v.t !== 'blob') out.stores[s].entries.push(entry);
            } catch (_) {}
            try { c.continue(); } catch (_) { if (!--pending) done(); }
          };
        });
        function done() { try { db.close(); } catch (_) {} resolve(out); }
      });
    });
  }

  /** Restore one snapshot into the local IndexedDB. `mergeOnly` skips the
   *  per-store `clear()` so we keep entries the snapshot didn't capture —
   *  important for shared engine virtual filesystems where multiple games
   *  cohabit a single DB (Unity IDBFS at `/idbfs`). The default behaviour
   *  remains the lossy clear-then-put used by single-tenant game DBs.
   *
   *  We open the DB without a version so IndexedDB picks whatever is locally
   *  current (or 1 on fresh devices). Older snapshots written when the
   *  engine used a different DB version would otherwise throw `VersionError`
   *  when restoring onto a device that has already opened the DB at a
   *  higher version. After the open succeeds we still create any missing
   *  object stores via a follow-up upgrade if the snapshot needs one. */
  function restoreOne(snapshot, mergeOnly) {
    var name = snapshot && snapshot.name;
    if (!name || !snapshot.stores) return Promise.resolve(false);
    return new Promise(function (resolve, reject) {
      try {
        var req = indexedDB.open(name);
        req.onupgradeneeded = function () {
          var db = req.result;
          Object.keys(snapshot.stores).forEach(function (s) {
            if (!db.objectStoreNames.contains(s)) {
              var opts = {};
              if (snapshot.stores[s].keyPath) opts.keyPath = snapshot.stores[s].keyPath;
              if (snapshot.stores[s].autoInc) opts.autoIncrement = true;
              try { db.createObjectStore(s, opts); } catch (_) {}
            }
          });
        };
        req.onerror = function () { reject(req.error || new Error('open failed')); };
        req.onblocked = function () { reject(new Error('blocked')); };
        req.onsuccess = function () {
          var db = req.result;
          var snapStoreNames = Object.keys(snapshot.stores);
          var missing = snapStoreNames.filter(function (s) { return !db.objectStoreNames.contains(s); });
          if (missing.length) {
            // Create missing stores via a version bump. Close the current
            // connection first or the upgrade transaction will be blocked.
            var nextVersion = (db.version || 1) + 1;
            try { db.close(); } catch (_) {}
            var upgradeReq = indexedDB.open(name, nextVersion);
            upgradeReq.onupgradeneeded = function () {
              var udb = upgradeReq.result;
              missing.forEach(function (s) {
                var opts = {};
                if (snapshot.stores[s].keyPath) opts.keyPath = snapshot.stores[s].keyPath;
                if (snapshot.stores[s].autoInc) opts.autoIncrement = true;
                try { udb.createObjectStore(s, opts); } catch (_) {}
              });
            };
            upgradeReq.onerror = function () { reject(upgradeReq.error || new Error('upgrade failed')); };
            upgradeReq.onblocked = function () { reject(new Error('upgrade blocked')); };
            upgradeReq.onsuccess = function () {
              applyEntries(upgradeReq.result);
            };
            return;
          }
          applyEntries(db);
        };
        function applyEntries(db) {
          var stores = Object.keys(snapshot.stores).filter(function (s) { return db.objectStoreNames.contains(s); });
          if (!stores.length) { try { db.close(); } catch (_) {} return resolve(true); }
          var tx;
          try { tx = db.transaction(stores, 'readwrite'); }
          catch (err) { try { db.close(); } catch (_) {} return reject(err); }
          tx.oncomplete = function () { try { db.close(); } catch (_) {} resolve(true); };
          tx.onerror = function () { try { db.close(); } catch (_) {} reject(tx.error || new Error('tx failed')); };
          stores.forEach(function (s) {
            var store = tx.objectStore(s);
            // Lossy clear-then-put gives "make local exactly match cloud"
            // semantics, which is what a fresh sign-in on a new device
            // expects. The shared-DB case (e.g. Unity IDBFS holding both
            // Hollow Knight and Silksong files) opts into a merge instead
            // so syncing one game doesn't blow away the other's files.
            if (!mergeOnly) {
              try { store.clear(); } catch (_) {}
            }
            var entries = snapshot.stores[s].entries || [];
            for (var i = 0; i < entries.length; i++) {
              var e = entries[i];
              var value = decodeValue(e.v);
              try {
                if (store.keyPath) store.put(value);
                else store.put(value, e.k);
              } catch (_) {}
            }
          });
        }
      } catch (err) { reject(err); }
    });
  }

  function resolveIdbNames(names) {
    if (Array.isArray(names)) {
      // When the caller hand-picks names we trust them — they may legitimately
      // want to back up engine virtual-FS data as a one-off operation.
      return Promise.resolve(names.filter(Boolean));
    }
    if (typeof names === 'string') return Promise.resolve([names]);
    // Auto mode: skip engine virtual filesystems and Emscripten asset caches.
    // Virtual filesystems hold typed data the older JSON encoder used to
    // corrupt and can be hundreds of MB; engine caches are even bigger and
    // are just cached downloads, not save data. Pages that need a virtual FS
    // synced (Unity WebGL, Godot, ...) opt in with `registerGameSave(name)`,
    // which handles their restore + auto-snapshot through the explicit path.
    return listIdbDatabases().then(function (list) {
      return (list || []).filter(function (n) {
        if (isVirtualFsName(n)) return false;
        if (isEngineCacheName(n)) return false;
        return true;
      });
    });
  }

  function snapshotIdb(names) {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    return resolveIdbNames(names).then(function (list) {
      if (!list.length) return [];
      var results = [];
      return list.reduce(function (chain, name) {
        return chain.then(function () {
          return snapshotOne(name).then(function (snap) {
            var json = JSON.stringify(snap);
            if (json.length > IDB_SNAPSHOT_BYTES) return { name: name, skipped: 'too_large', size: json.length };
            return request('/api/saves', {
              method: 'PUT',
              body: JSON.stringify({
                origin: STORAGE_NAMESPACE,
                key: name,
                value: json,
                kind: IDB_KIND_PREFIX + 'default',
                updated_at: Date.now(),
              }),
            }).then(function () { return { name: name, ok: true, size: json.length }; });
          }).catch(function (err) { return { name: name, error: err && err.message || String(err) }; });
        }).then(function (r) { results.push(r); return results; });
      }, Promise.resolve()).then(function () { return results; });
    });
  }

  function restoreIdb(names) {
    if (!authState) return Promise.reject(new Error('Not signed in'));
    return resolveIdbNames(names).then(function (list) {
      // If nothing specified we try to restore whatever the server has for this user.
      var fetchServer = list.length
        ? Promise.all(list.map(function (n) {
            var q = '?origin=' + encodeURIComponent(STORAGE_NAMESPACE) + '&key=' + encodeURIComponent(n) + '&kind=' + encodeURIComponent(IDB_KIND_PREFIX + 'default');
            return request('/api/saves/one' + q).then(function (d) { return d && d.value ? { name: n, value: d.value, updated_at: d.updated_at } : null; }).catch(function () { return null; });
          }))
        : request('/api/saves?origin=' + encodeURIComponent(STORAGE_NAMESPACE) + '&kind=' + encodeURIComponent(IDB_KIND_PREFIX + 'default'))
            .then(function (data) {
              return (data && data.items || []).map(function (it) { return { name: it.key, value: it.value, updated_at: it.updated_at }; });
            });
      return fetchServer.then(function (rows) {
        var valid = (rows || []).filter(Boolean);
        var results = [];
        return valid.reduce(function (chain, row) {
          return chain.then(function () {
            var snap;
            try { snap = JSON.parse(row.value); } catch (_) { results.push({ name: row.name, skipped: 'parse' }); return results; }
            // Engine virtual filesystems (e.g. Unity IDBFS at `/idbfs`) are
            // shared by every game on this origin that uses the engine, so
            // restore in merge mode — keep entries already present locally
            // that the cloud snapshot doesn't include. Per-game IDBs keep
            // the original "clear first" semantics so a fresh sign-in
            // reproduces the account exactly.
            var mergeOnly = isVirtualFsName(row.name) || isRegisteredGameSave(row.name);
            return restoreOne(snap, mergeOnly).then(function () { results.push({ name: row.name, ok: true }); }).catch(function (err) { results.push({ name: row.name, error: err && err.message || String(err) }); });
          });
        }, Promise.resolve()).then(function () { return results; });
      });
    });
  }

  /** Detect entries that match the legacy "snapshot then restore" corruption
   *  shape that older versions of this file produced for Unity/Godot virtual
   *  filesystems. The IDBFS layout is `{contents: Uint8Array, timestamp: Date,
   *  mode: number}`; once round-tripped through JSON.stringify by our broken
   *  encoder, `contents` becomes a plain object with numeric string keys and
   *  `timestamp` becomes an ISO string. Either condition is enough to make
   *  Unity's `reconcile` throw `e2.timestamp.getTime is not a function`. */
  function isCorruptedFsEntry(value) {
    if (!value || typeof value !== 'object') return false;
    if (!('contents' in value) || !('timestamp' in value)) return false;
    if (value.timestamp instanceof Date && (value.contents instanceof Uint8Array)) return false;
    return true;
  }

  function repairFsEntry(value) {
    var out = {};
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = value[k];
    }
    if (out.timestamp instanceof Date) {
      // already fine
    } else if (typeof out.timestamp === 'number') {
      out.timestamp = new Date(out.timestamp);
    } else if (typeof out.timestamp === 'string') {
      var parsed = new Date(out.timestamp);
      out.timestamp = isNaN(parsed.getTime()) ? new Date(0) : parsed;
    } else {
      out.timestamp = new Date(0);
    }
    if (out.contents instanceof Uint8Array) {
      // already fine
    } else if (Array.isArray(out.contents)) {
      out.contents = new Uint8Array(out.contents);
    } else if (out.contents && typeof out.contents === 'object') {
      // Plain object with numeric-string keys, e.g. {"0":1,"1":2,...}.
      var keys = Object.keys(out.contents);
      var size = 0;
      for (var i = 0; i < keys.length; i++) {
        var idx = parseInt(keys[i], 10);
        if (!isNaN(idx) && idx + 1 > size) size = idx + 1;
      }
      var u8 = new Uint8Array(size);
      for (var j = 0; j < keys.length; j++) {
        var ki = parseInt(keys[j], 10);
        if (!isNaN(ki)) u8[ki] = out.contents[keys[j]] | 0;
      }
      out.contents = u8;
    } else {
      out.contents = new Uint8Array(0);
    }
    return out;
  }

  function repairOneVirtualFs(name) {
    return openDb(name).then(function (db) {
      var stores = Array.from(db.objectStoreNames || []);
      if (!stores.length) { try { db.close(); } catch (_) {} return 0; }
      return new Promise(function (resolve) {
        var tx;
        try { tx = db.transaction(stores, 'readwrite'); }
        catch (_) { try { db.close(); } catch (__) {} return resolve(0); }
        var fixed = 0;
        var pending = stores.length;
        function done() { if (!--pending) { try { db.close(); } catch (_) {} resolve(fixed); } }
        stores.forEach(function (s) {
          var store;
          try { store = tx.objectStore(s); } catch (_) { return done(); }
          var cursorReq;
          try { cursorReq = store.openCursor(); } catch (_) { return done(); }
          cursorReq.onerror = done;
          cursorReq.onsuccess = function () {
            var c = cursorReq.result;
            if (!c) return done();
            try {
              if (isCorruptedFsEntry(c.value)) {
                c.update(repairFsEntry(c.value));
                fixed++;
              }
            } catch (_) {}
            try { c.continue(); } catch (_) { done(); }
          };
        });
      });
    }).catch(function () { return 0; });
  }

  /** Walk every engine virtual-filesystem database the origin owns and rewrite
   *  any corrupted IDBFS entries we previously created. Runs once per session
   *  early at boot, *before* the engine opens its filesystem, so by the time
   *  Unity calls `FS.syncfs` the data is back in the shape it expects. */
  function repairVirtualFsDatabases() {
    if (window.__jqrg_idb_repair_done) return Promise.resolve(0);
    window.__jqrg_idb_repair_done = true;
    return listIdbDatabases().then(function (list) {
      var virtualFs = (list || []).filter(isVirtualFsName);
      if (!virtualFs.length) return 0;
      return virtualFs.reduce(function (chain, name) {
        return chain.then(function (count) {
          return repairOneVirtualFs(name).then(function (n) { return count + n; });
        });
      }, Promise.resolve(0));
    }).catch(function () { return 0; });
  }

  // Two channels of names the auto-sync handler watches. `idbAutoExplicit`
  // accumulates names callers pinned (e.g. each game registering its own
  // virtual-FS DB), and `idbAutoEnabled` flips on once any game has wired
  // up auto-sync at all. When both are empty we still sync the auto-detected
  // non-virtual DBs because that path was the original behaviour for plain
  // IDB-based games.
  var idbAutoExplicit = [];
  var idbAutoEnabled = false;
  function autoSyncIdb(names) {
    if (Array.isArray(names) && names.length) {
      // Additive: multiple games can register their own DB names without
      // clobbering each other's. Existing entries are kept.
      for (var i = 0; i < names.length; i++) {
        if (!names[i]) continue;
        if (idbAutoExplicit.indexOf(names[i]) === -1) idbAutoExplicit.push(names[i]);
      }
    }
    idbAutoEnabled = true;
    if (window.__jqrg_idb_auto_bound) return;
    window.__jqrg_idb_auto_bound = true;
    var sync = function () {
      if (!authState) return;
      try {
        // Always snapshot the auto-detected non-virtual DBs the way the
        // legacy single-arg autoSyncIdb did.
        snapshotIdb().catch(function () {});
        if (idbAutoExplicit.length) {
          snapshotIdb(idbAutoExplicit.slice()).catch(function () {});
        }
      } catch (_) {}
    };
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') sync();
      });
      window.addEventListener('pagehide', sync);
      window.addEventListener('beforeunload', sync);
    } catch (_) {}
  }

  /** Game-page hook: declare an IndexedDB database whose contents follow the
   *  signed-in user across devices. Designed for engines whose save layer
   *  the auto-detect path skips on purpose — Unity WebGL parks its IDBFS at
   *  `/idbfs`, Godot at `/userfs`, etc. (`isVirtualFsName` filters these out
   *  because some legacy snapshots corrupted typed values, but our current
   *  encoder round-trips Uint8Array + Date safely).
   *
   *  Behaviour:
   *    1. If the visitor is already signed in, pulls the latest server
   *       snapshot for `idbName` and restores it before resolving so the
   *       engine reads cloud data when it opens the DB. Resolves to `null`
   *       if no server data exists.
   *    2. Wires the DB into auto-sync so `visibilitychange:hidden`,
   *       `pagehide`, and `beforeunload` snapshot it back to the server.
   *    3. Adds the name to a registered list so `pushAllLocal()` includes it
   *       in manual sync flows even though it would otherwise be filtered.
   *
   *  We intentionally do NOT restore mid-game when a user signs in AFTER
   *  the game has booted: that would clobber their unsaved progress with a
   *  cloud version they may not have intended to load. Anonymous play still
   *  benefits from the auto-sync wiring — once they sign in, future
   *  visibilitychange/pagehide events push their progress up.
   *
   *  Safe to call multiple times with the same name (idempotent) and from
   *  any page. The returned promise never rejects — failures are surfaced
   *  via console warnings instead so a flaky network can't block the game
   *  boot. */
  var registeredGameSaves = [];
  function isRegisteredGameSave(name) {
    return registeredGameSaves.indexOf(name) !== -1;
  }
  function registerGameSave(idbName) {
    if (typeof idbName !== 'string' || !idbName) {
      return Promise.reject(new Error('idbName required'));
    }
    if (registeredGameSaves.indexOf(idbName) === -1) registeredGameSaves.push(idbName);
    autoSyncIdb([idbName]);
    if (!authState) return Promise.resolve(null);
    return restoreIdb([idbName]).catch(function (err) {
      try { console.warn('[jqrg-cloud] registerGameSave restore failed for ' + idbName, err); } catch (_) {}
      return null;
    });
  }

  /** Detect game engines and auto-enable IDB sync once per page load.
   *  Covers: Unity WebGL, Construct 2/3, Godot, EmulatorJS, Ruffle/Flash,
   *  GameMaker HTML5, Eaglercraft (1.5.2, 1.8.x, 1.12.x). Falls back to a timed
   *  trigger on any /q/g/, /jg/g/, /q/e/ or /jg/e/ path. */
  function autoWireCommonEngines() {
    if (window.__jqrg_idb_auto_wired) return;
    try {
      var disableMeta = document.querySelector && document.querySelector('meta[name="jqrg-cloud-disable-idb-autowire"]');
      if (disableMeta && disableMeta.content) {
        var disableVal = String(disableMeta.content).toLowerCase();
        if (disableVal === '1' || disableVal === 'true' || disableVal === 'yes' || disableVal === 'on') {
          return;
        }
      }
    } catch (_) {}
    window.__jqrg_idb_auto_wired = true;
    // Kick off a repair pass immediately - older versions of this file fed
    // typed Unity IDBFS entries through a JSON round-trip that flattened Date
    // → string and Uint8Array → plain object, leaving the local DB in a state
    // where Unity's FS.syncfs reconcile would throw `e2.timestamp.getTime is
    // not a function`. The pass is gated by a sessionwide flag so it runs at
    // most once per page; it touches only databases whose name starts with
    // "/" (i.e. engine virtual filesystems) and only entries that already look
    // corrupt, so it's a safe no-op on healthy data.
    var repairPromise = repairVirtualFsDatabases();
    var triggered = false;
    var trigger = function () {
      if (triggered) return;
      triggered = true;
      var doRestore = function () {
        repairPromise.catch(function () {}).then(function () {
          restoreIdb().catch(function () {}).then(function () { autoSyncIdb(); });
        });
      };
      if (!authState) {
        authChangeHandlers.push(function onceAuth() {
          if (authState) {
            var idx = authChangeHandlers.indexOf(onceAuth);
            if (idx !== -1) authChangeHandlers.splice(idx, 1);
            doRestore();
          }
        });
        return;
      }
      doRestore();
    };
    // Unity: intercept createUnityInstance assignment
    try {
      var desc = Object.getOwnPropertyDescriptor(window, 'createUnityInstance');
      if (!desc) {
        var currentValue;
        Object.defineProperty(window, 'createUnityInstance', {
          configurable: true,
          get: function () { return currentValue; },
          set: function (v) { currentValue = v; trigger(); },
        });
      } else {
        trigger();
      }
    } catch (_) {}
    // Poll for Unity, Construct, Godot, EmulatorJS, Ruffle, GameMaker,
    // Eaglercraft globals. Unity loader scripts often declare
    // `function createUnityInstance(...)` at top-level, which can bypass the
    // setter trap above by replacing the property descriptor directly.
    var poll = 0;
    var poller = setInterval(function () {
      poll++;
      if (triggered) { clearInterval(poller); return; }
      if (typeof window.createUnityInstance === 'function') trigger();       // Unity (function declaration path)
      if (window.cr_getC2Runtime || window.C3Runtime) trigger();              // Construct 2/3
      if (window.Engine && window.GODOT_CONFIG) trigger();                    // Godot
      if (window.EJS_player || window.EJS_emulator) trigger();                // EmulatorJS
      if (window.RufflePlayer || document.querySelector('ruffle-player')) trigger(); // Ruffle
      if (window.GameMaker_Init || window.gml_Script_scr_adaptaliases) trigger();   // GameMaker HTML5
      // Eaglercraft sets one of these globals during launcher bootstrap. The 1.5.2
      // legacy build uses `eaglercraftOpts`; 1.8.x / 1.12.x (TeaVM and WASM)
      // use `eaglercraftXOpts` or its early `eaglercraftXOptsHints` companion.
      if (window.eaglercraftXOpts || window.eaglercraftXOptsHints || window.eaglercraftOpts) trigger();
      if (poll > 120) clearInterval(poller);
    }, 1000);
    // Fallback: any page under /q/g/, /jg/g/, /q/e/ or /jg/e/
    // triggers after 3s regardless. Eaglercraft variants don't expose any of the
    // engine globals the poller looks for, so this fallback is the main hook
    // that gets world-save IndexedDBs (`worlds`, `_eaglercraft.*`) backed up.
    try {
      var p = location.pathname || '';
      // Only eaglercraft needs the early timer — it never exposes createUnityInstance.
      // A 3s trigger on /q/g/* ran before slow Unity builds assigned
      // createUnityInstance, so restoreIdb/repair could touch IndexedDB while a
      // WebGL title was still streaming assets (e.g. Hollow Knight), which broke
      // Unity's own IDBFS init ("IndexedDB is not available").
      if (p.indexOf('/q/e/') === 0 || p.indexOf('/jg/e/') === 0) {
        setTimeout(function () { trigger(); }, 3000);
      }
    } catch (_) {}
  }

  var api = {
    SERVER: SERVER,
    namespace: STORAGE_NAMESPACE,
    isLoggedIn: function () { return !!authState; },
    getUser: function () { return authState ? authState.user : null; },
    getToken: function () { return authState ? authState.token : null; },
    onAuthChange: function (fn) {
      if (typeof fn === 'function') authChangeHandlers.push(fn);
      return function () {
        var idx = authChangeHandlers.indexOf(fn);
        if (idx !== -1) authChangeHandlers.splice(idx, 1);
      };
    },
    skipKey: function (prefix) { if (typeof prefix === 'string') userSkipPrefixes.push(prefix); },
    skipKeys: function (list) { if (Array.isArray(list)) list.forEach(function (p) { api.skipKey(p); }); },
    login: login,
    register: register,
    sendVerifyCode: sendVerifyCode,
    requestAccountKeyView: requestAccountKeyView,
    viewAccountKey: viewAccountKey,
    recoverStart: recoverStart,
    recoverEmailHint: recoverEmailHint,
    recoverSendCode: recoverSendCode,
    recoverComplete: recoverComplete,
    recoverFreeze: recoverFreeze,
    forgotPassword: forgotPassword,
    reportBlockedEmail: reportBlockedEmail,
    logout: logout,
    forceSync: forceSync,
    pushSave: pushSave,
    fetchSave: fetchSave,
    exportAll: exportAll,
    importAll: importAll,
    deleteAll: deleteAll,
    snapshotIdb: snapshotIdb,
    restoreIdb: restoreIdb,
    autoSyncIdb: autoSyncIdb,
    /**
     * Opt a game's IndexedDB save data into cloud sync. Use this for engines
     * whose persistence layer the auto-detect would normally skip (Unity
     * IDBFS at `/idbfs`, Godot at `/userfs`, etc). Call once near the top of
     * the page before booting the engine — registerGameSave() restores the
     * latest snapshot from the user's account before resolving so the engine
     * reads cloud data when it opens the DB. Idempotent.
     */
    registerGameSave: registerGameSave,
    whoAmI: whoAmI,
    hasUnsyncedLocalData: hasUnsyncedLocalData,
    hasLocalSyncableData: hasLocalSyncableData,
    listLocalSyncableKeys: listLocalSyncableKeys,
    isAccountEmpty: isAccountEmpty,
    pushAllLocal: pushAllLocal,
    mergeLocalToAccount: mergeLocalToAccount,
    wipeLocalSyncable: wipeLocalSyncable,
    skipLocalMigration: skipLocalMigration,
    hasRecordedMigration: hasRecordedMigration,
    openSsoChatUrl: function (next) {
      if (!authState) return SERVER + '/';
      var tail = next && typeof next === 'string' && next.charAt(0) === '/' ? next : '/';
      return SERVER + '/api/auth/sso?sso=' + encodeURIComponent(authState.token) + '&next=' + encodeURIComponent(tail);
    },
    /** PATCH /api/users/profile with the given fields. Currently used by the
     *  account UI to set/clear `email` so users whose chat account pre-dates
     *  the email column can opt into email-based sign-in. The chat backend
     *  validates format + uniqueness and returns the refreshed user record;
     *  on success we update the cached authState so refreshButton(), the
     *  profile modal, and any later /me checks all see the new value. */
    updateProfile: function (fields) {
      if (!authState) return Promise.reject(new Error('Not signed in'));
      if (!fields || typeof fields !== 'object') return Promise.reject(new Error('No fields'));
      return request('/api/users/profile', {
        method: 'PATCH',
        body: JSON.stringify(fields),
      }).then(function (data) {
        if (data && data.error) throw new Error(data.error);
        if (data && data.user && authState) {
          // Merge so we keep token & savedAt; only the user record changes.
          authState.user = data.user;
          writeJSON(AUTH_KEY, authState);
          fireAuthChange();
        }
        return data && data.user;
      });
    },
    _internals: { request: request, flushPending: flushPending, enqueue: enqueue },
  };
  window.JqrgCloud = api;

  try { installInterceptor(); } catch (e) { console.warn('[jqrg-cloud] interceptor failed', e); }
  try { installStorageListener(); } catch (e) { console.warn('[jqrg-cloud] storage listener failed', e); }
  try { autoWireCommonEngines(); } catch (e) { console.warn('[jqrg-cloud] engine auto-wire failed', e); }
  if (authState) {
    bootstrapToken().then(function () {
      flushPending();
      forceSync().catch(function () {});
      startPeriodicSync();
    }).catch(function () {});
  }

  // If the page was loaded via an SSO hand-off (?sso=TOKEN), pick it up, stash it, and clean the URL.
  try {
    var params = new URLSearchParams(window.location.search);
    var sso = params.get('sso');
    if (sso) {
      request('/api/auth/me', { headers: { Authorization: 'Bearer ' + sso } })
        .then(function (data) {
          if (data && data.user) {
            setAuth(data.user, sso);
            pullFromServer(0).then(function () { startPeriodicSync(); }).catch(function () {});
          }
        })
        .catch(function () {})
        .then(function () {
          try {
            params.delete('sso');
            var q = params.toString();
            var url = window.location.pathname + (q ? '?' + q : '') + window.location.hash;
            window.history.replaceState({}, '', url);
          } catch (_) {}
        });
    }
  } catch (_) {}
})();
