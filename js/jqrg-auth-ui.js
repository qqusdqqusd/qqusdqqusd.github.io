/* jqrg-auth-ui.js
 * Adds a profile/sign-in button to the top bar and a login/signup/account modal. Depends on
 * jqrg-cloud.js (loaded first) which exposes window.JqrgCloud. Safe to include once per page.
 *
 * The site is auth-gated: on every same-origin page load we check whether the user has a
 * valid session. If not we pop up the sign-in modal in "required" mode (no close button,
 * escape key disabled, background click disabled) until the user signs in or signs up.
 *
 * The account modal also exposes:
 *   - Export data    – downloads a JSON snapshot of every cloud save (localStorage + idb kinds)
 *   - Import data    – accepts a JSON file (or raw JSON string) and bulk-uploads it
 *   - Delete all data – asks the user to type DELETE before wiping server + local storage
 */
(function () {
  'use strict';
  if (window.__JqrgAuthUiLoaded) return;
  window.__JqrgAuthUiLoaded = true;

  var Cloud = window.JqrgCloud;
  if (!Cloud) {
    console.warn('[jqrg-auth-ui] JqrgCloud not found; is jqrg-cloud.js included first?');
    return;
  }

  /** Pages that should never be gated behind login (error pages, unsubscribes, etc.). */
  var GATE_SKIP_PATHS = [
    '/403.html', '/404.html', '/404-safe.html', '/404-building.html',
  ];

  /** Returns 'block' if the current page should be redirected to home (sub-pages),
   *  'gate' if we should show the modal on the current page (home page),
   *  or false if no gating applies. To bypass the gate during local development set
   *  `window.__JqrgAuthGateDisabled = true` before this script runs. */
  function shouldGate() {
    if (window.__JqrgAuthGateDisabled) return false;
    if (window.top !== window.self) return false; // don't gate inside iframes
    var path = (location.pathname || '').toLowerCase();
    for (var i = 0; i < GATE_SKIP_PATHS.length; i++) {
      if (path === GATE_SKIP_PATHS[i] || path.endsWith(GATE_SKIP_PATHS[i])) return false;
    }
    return true;
  }

  /** Check if the URL hash points to a non-home tab. */
  function isSubPage() {
    var hash = (location.hash || '').slice(1).toLowerCase();
    return hash === 'g' || hash === 'a' || hash === 'u' || hash === 'c';
  }

  /** True if the current path is NOT the main index.html page. */
  function isOffHomePath() {
    var path = (location.pathname || '').replace(/\/+$/, '').toLowerCase();
    return path !== '' && path !== '/index.html';
  }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v != null) el.setAttribute(k, v);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return el;
  }

  // Inline SVG icons used in the account modal action buttons. They use currentColor so the
  // danger variant (red text) tints the stroke automatically.
  var ICON_EXPORT_SVG =
    '<svg viewBox="0 0 29 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M9.34688 17.8643L14.2531 22.75M14.2531 22.75L19.1593 17.8643M14.2531 22.75V11.7571M25.1449 19.1956C26.2113 18.4489 27.0109 17.3832 27.4279 16.1532C27.8448 14.9232 27.8573 13.5929 27.4636 12.3554C27.0698 11.1179 26.2903 10.0375 25.2382 9.27097C24.1861 8.50448 22.916 8.09181 21.6124 8.09282H20.067C19.6981 6.66115 19.0078 5.33147 18.0482 4.20388C17.0886 3.0763 15.8846 2.18019 14.5269 1.58302C13.1692 0.985857 11.6931 0.703194 10.2098 0.756313C8.7265 0.809432 7.27463 1.19695 5.9635 1.88969C4.65236 2.58243 3.51612 3.56235 2.64031 4.75566C1.7645 5.94898 1.17196 7.3246 0.907278 8.77896C0.642598 10.2333 0.712684 11.7285 1.11226 13.152C1.51183 14.5755 2.23048 15.8902 3.21411 16.9971" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  var ICON_IMPORT_SVG =
    '<svg viewBox="0 0 29 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M9.34688 16.6428L14.2531 11.7571M14.2531 11.7571L19.1593 16.6428M14.2531 11.7571V22.75M25.1449 19.1956C26.2113 18.4489 27.0109 17.3832 27.4279 16.1532C27.8448 14.9232 27.8573 13.593 27.4636 12.3554C27.0698 11.1179 26.2903 10.0375 25.2382 9.27097C24.1861 8.50448 22.916 8.09181 21.6124 8.09282H20.067C19.6981 6.66115 19.0078 5.33147 18.0482 4.20388C17.0886 3.0763 15.8846 2.18019 14.5269 1.58302C13.1692 0.985857 11.6931 0.703194 10.2098 0.756313C8.7265 0.809432 7.27463 1.19695 5.96349 1.88969C4.65236 2.58243 3.51612 3.56235 2.64031 4.75566C1.7645 5.94898 1.17196 7.3246 0.907278 8.77896C0.642598 10.2333 0.712684 11.7285 1.11226 13.152C1.51183 14.5755 2.23048 15.8902 3.21411 16.9971" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  var ICON_TRASH_SVG =
    '<svg viewBox="0 0 22 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M0.75 5.15H2.97222M2.97222 5.15H20.75M2.97222 5.15V20.55C2.97222 21.1335 3.20635 21.6931 3.6231 22.1056C4.03984 22.5182 4.60507 22.75 5.19444 22.75H16.3056C16.8949 22.75 17.4602 22.5182 17.8769 22.1056C18.2937 21.6931 18.5278 21.1335 18.5278 20.55V5.15M6.30556 5.15V2.95C6.30556 2.36652 6.53968 1.80695 6.95643 1.39437C7.37318 0.981785 7.93841 0.75 8.52778 0.75H12.9722C13.5616 0.75 14.1268 0.981785 14.5436 1.39437C14.9603 1.80695 15.1944 2.36652 15.1944 2.95V5.15M8.52778 10.65V17.25M12.9722 10.65V17.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  var ICON_SIGNOUT_SVG =
    '<svg viewBox="0 0 27 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M9.71447 5.75V3.25C9.71447 1.86929 10.8338 0.75 12.2145 0.75H23.2145C24.5952 0.75 25.7145 1.86929 25.7145 3.25V20.25C25.7145 21.6307 24.5952 22.75 23.2145 22.75H12.2145C10.8338 22.75 9.71447 21.6307 9.71447 20.25V17.75M6.71447 9.75H17.7145C18.819 9.75 19.7145 10.6454 19.7145 11.75C19.7145 12.8546 18.819 13.75 17.7145 13.75H6.71447M5.71447 5.75L1.48223 9.98223C0.505923 10.9585 0.505922 12.5415 1.48223 13.5178L5.71447 17.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>';
  var ICON_KEY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M15 7C15 9.20914 13.2091 11 11 11C8.79086 11 7 9.20914 7 7C7 4.79086 8.79086 3 11 3C13.2091 3 15 4.79086 15 7ZM15 7H21M18 7V11M21 7V11M11 11V21M7 17H15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function actionIcon(svgMarkup) {
    return h('span', { class: 'icon', html: svgMarkup });
  }

  function injectStyles() {
    if (document.getElementById('jqrg-auth-ui-css')) return;
    var style = h('style', { id: 'jqrg-auth-ui-css' });
    style.textContent = [
      '.jqrg-auth-btn{',
      '  position:relative;display:inline-flex;align-items:center;gap:8px;',
      '  height:36px;padding:0 12px;border:0;background:transparent;color:inherit;',
      '  border-radius:10px;cursor:pointer;font-family:inherit;font-size:13px;',
      '  transition:background .25s ease,transform .25s ease;',
      '}',
      '.jqrg-auth-btn:hover{background:rgba(255,255,255,.08)}',
      '.jqrg-auth-btn .jqrg-avatar{',
      '  width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#8841d6,#4f46e5);',
      '  display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;',
      '  color:#fff;flex-shrink:0;overflow:hidden;',
      '}',
      '.jqrg-auth-btn .jqrg-avatar.has-img{background:transparent}',
      '.jqrg-auth-btn .jqrg-avatar img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%}',
      '.jqrg-auth-btn .jqrg-label{max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.jqrg-auth-btn.logged-out .jqrg-avatar{background:rgba(255,255,255,.08);color:rgba(255,255,255,.7)}',
      // The overlay's BACKGROUND is the only darken layer. We intentionally do NOT
      // use a ::before pseudo-element here — earlier attempts stacked the pseudo
      // (position:fixed, z-index:0) above the modal in some browsers because each
      // creates its own stacking context and Safari/Chromium occasionally paint the
      // fixed-position child on top of relative siblings inside the same parent.
      // Using only `background` avoids the issue entirely: the overlay's background
      // is always painted underneath any child element.
      '.jqrg-auth-overlay{',
      '  position:fixed;inset:0;background:rgba(5,0,15,.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
      '  display:flex;align-items:center;justify-content:center;z-index:2147483000;',
      '  opacity:0;pointer-events:none;transition:opacity .25s ease,background-color .25s ease;padding:16px;',
      '  isolation:isolate;', // self-contained stacking context, just to be safe
      '}',
      '.jqrg-auth-overlay.open{opacity:1;pointer-events:auto}',
      // Required mode just darkens the overlay further. No pseudo-element involved.
      '.jqrg-auth-overlay.required{background:rgba(2,0,8,.94)}',
      '.jqrg-auth-modal{',
      '  position:relative;z-index:1;',
      '  background:#1d1635;border:1px solid rgba(255,255,255,.12);border-radius:16px;',
      '  padding:22px;max-width:560px;width:100%;color:#fff;',
      '  box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 0 1px rgba(136,65,214,.18);',
      '  max-height:90vh;overflow:auto;',
      '}',
      '.jqrg-auth-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}',
      '.jqrg-auth-title{font-size:18px;font-weight:700}',
      '.jqrg-auth-close{background:transparent;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}',
      '.jqrg-auth-close[disabled]{display:none}',
      '.jqrg-auth-form{display:flex;flex-direction:column;gap:12px}',
      '.jqrg-auth-tabs{display:flex;gap:4px;padding:4px;background:rgba(255,255,255,.05);border-radius:10px;margin-bottom:6px}',
      '.jqrg-auth-tab{flex:1;padding:8px;border:0;background:transparent;color:rgba(255,255,255,.65);border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;transition:all .25s ease}',
      '.jqrg-auth-tab.active{background:linear-gradient(135deg,rgba(136,65,214,.6),rgba(79,70,229,.6));color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
      '.jqrg-auth-form label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:rgba(255,255,255,.75)}',
      '.jqrg-auth-form input{',
      '  padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);',
      '  color:#fff;border-radius:10px;font-family:inherit;font-size:14px;outline:none;',
      '  transition:border-color .25s ease,background .25s ease;',
      '}',
      '.jqrg-auth-form input:focus{border-color:rgba(136,65,214,.7);background:rgba(255,255,255,.12)}',
      '.jqrg-auth-submit{',
      '  padding:10px 16px;background:linear-gradient(135deg,#8841d6,#6d28d9);',
      '  border:0;color:#fff;border-radius:10px;font-family:inherit;font-size:14px;',
      '  cursor:pointer;font-weight:600;transition:transform .2s ease,box-shadow .25s ease;',
      '}',
      '.jqrg-auth-submit:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(136,65,214,.35)}',
      '.jqrg-auth-submit:disabled{opacity:.6;cursor:wait;transform:none;box-shadow:none}',
      '.jqrg-auth-error{color:#ff7a7a;font-size:13px;min-height:18px;margin:-4px 0 4px}',
      '.jqrg-auth-success{color:#7affa0;font-size:13px;min-height:18px;margin:-4px 0 4px}',
      '.jqrg-auth-hint{color:rgba(255,255,255,.6);font-size:12px;line-height:1.4}',
      '.jqrg-gate-intro{',
      '  background:rgba(136,65,214,.15);border:1px solid rgba(136,65,214,.35);border-radius:12px;',
      '  padding:12px 14px;margin-bottom:6px;color:rgba(255,255,255,.85);font-size:13px;line-height:1.45;',
      '}',
      '.jqrg-verify-info{font-size:12px;color:rgba(255,255,255,.7);line-height:1.4;padding:8px 10px;background:rgba(136,65,214,.12);border-radius:8px;border-left:3px solid #8841d6;margin-bottom:8px}',
      '.jqrg-verify-info strong{color:rgba(255,255,255,.9)}',
      '.jqrg-verify-info.ok{color:#7affa0;background:rgba(122,255,160,.08);border-left-color:#34d399}',
      '.jqrg-verify-info.ok strong{color:#b8ffd0}',
      '.jqrg-verify-row{display:flex;flex-direction:column;gap:6px}',
      '.jqrg-verify-row label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:rgba(255,255,255,.75)}',
      '.jqrg-verify-resend{background:none;border:0;color:#a78bfa;font-size:12px;cursor:pointer;padding:2px 0;text-decoration:underline;text-align:left}',
      '.jqrg-verify-resend:disabled{color:rgba(255,255,255,.4);cursor:default;text-decoration:none}',
      '.jqrg-send-code-btn{',
      '  padding:8px 0;border-radius:10px;border:1px solid rgba(136,65,214,.5);',
      '  background:rgba(136,65,214,.1);color:#a78bfa;font-weight:600;font-size:13px;',
      '  cursor:pointer;transition:background .15s;font-family:inherit;width:100%;',
      '}',
      '.jqrg-send-code-btn:hover{background:rgba(136,65,214,.2)}',
      '.jqrg-send-code-btn:disabled{opacity:.6;cursor:wait}',
      '.jqrg-profile-row{',
      '  display:flex;align-items:center;gap:12px;padding:12px;border:1px solid rgba(255,255,255,.1);',
      '  border-radius:12px;background:rgba(255,255,255,.04);',
      '}',
      '.jqrg-profile-row .jqrg-big-avatar{',
      '  width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#8841d6,#4f46e5);',
      '  display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:20px;',
      '  overflow:hidden;flex-shrink:0;',
      '}',
      '.jqrg-profile-row .jqrg-big-avatar.has-img{background:transparent}',
      '.jqrg-profile-row .jqrg-big-avatar img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%}',
      '.jqrg-profile-info{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}',
      '.jqrg-profile-name{font-size:15px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.jqrg-profile-user{font-size:12px;color:rgba(255,255,255,.55)}',
      '.jqrg-profile-actions{display:flex;flex-direction:column;gap:8px;margin-top:8px}',
      '.jqrg-profile-action{',
      '  padding:10px 14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);',
      '  color:#fff;border-radius:10px;font-family:inherit;font-size:13px;cursor:pointer;',
      '  text-align:left;display:flex;align-items:center;gap:10px;text-decoration:none;',
      '  transition:background .2s ease,border-color .2s ease,transform .2s ease;',
      '}',
      '.jqrg-profile-action:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.2);transform:translateY(-1px)}',
      '.jqrg-profile-action.danger{color:#ff7a7a;border-color:rgba(255,122,122,.25)}',
      '.jqrg-profile-action.danger:hover{background:rgba(255,122,122,.08)}',
      '.jqrg-profile-action .icon{width:22px;height:18px;display:inline-flex;justify-content:center;align-items:center;color:inherit}',
      '.jqrg-profile-action .icon svg{display:block;width:auto;height:18px;color:inherit}',
      '.jqrg-sync-status{font-size:11px;color:rgba(255,255,255,.45);margin-top:4px;text-align:center}',
      '.jqrg-sync-status.active{color:#7affa0}',
      '.jqrg-forgot-hint{font-size:12px;color:rgba(255,255,255,.55);text-align:center;margin-top:4px}',
      // Email row inside the profile pane. Shown for every signed-in user so
      // the value is visible at a glance, with an inline editor that flips
      // the row into a form when "Add email" / "Edit" is clicked. The "missing"
      // variant is highlighted because chat accounts that pre-date the email
      // column have NULL stored and need this UI to opt into email login.
      '.jqrg-email-section{display:flex;flex-direction:column;gap:6px}',
      '.jqrg-email-row{',
      '  display:flex;align-items:center;gap:10px;padding:10px 12px;',
      '  border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.04);',
      '}',
      '.jqrg-email-row.missing{border-color:rgba(255,200,80,.45);background:rgba(255,200,80,.08)}',
      '.jqrg-email-label{font-size:11px;color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}',
      '.jqrg-email-value{flex:1;min-width:0;font-size:13px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.jqrg-email-missing{flex:1;font-size:13px;color:rgba(255,200,80,.85);font-style:italic}',
      '.jqrg-email-edit{',
      '  flex-shrink:0;padding:6px 12px;background:rgba(255,255,255,.08);',
      '  border:1px solid rgba(255,255,255,.18);color:#fff;border-radius:8px;',
      '  font-family:inherit;font-size:12px;cursor:pointer;transition:background .2s ease;',
      '}',
      '.jqrg-email-edit:hover{background:rgba(255,255,255,.14)}',
      '.jqrg-email-row.missing .jqrg-email-edit{',
      '  background:linear-gradient(135deg,#8841d6,#6d28d9);border-color:transparent;font-weight:600;',
      '}',
      '.jqrg-email-row.missing .jqrg-email-edit:hover{box-shadow:0 4px 12px rgba(136,65,214,.35)}',
      '.jqrg-email-hint{font-size:11px;color:rgba(255,255,255,.55);padding:0 4px}',
      '.jqrg-email-form{',
      '  display:flex;flex-direction:column;gap:10px;padding:12px;',
      '  border:1px solid rgba(136,65,214,.4);border-radius:10px;background:rgba(136,65,214,.06);',
      '}',
      '.jqrg-email-form label{display:flex;flex-direction:column;gap:6px;font-size:11px;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.05em}',
      '.jqrg-email-form input{',
      '  padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);',
      '  color:#fff;border-radius:8px;font-family:inherit;font-size:14px;outline:none;',
      '  transition:border-color .25s ease,background .25s ease;',
      '}',
      '.jqrg-email-form input:focus{border-color:rgba(136,65,214,.7);background:rgba(255,255,255,.12)}',
      '.jqrg-email-actions{display:flex;gap:8px}',
      '.jqrg-email-actions button{flex:1}',
      '.jqrg-confirm-msg{font-size:14px;color:#fff;line-height:1.45}',
      '.jqrg-confirm-danger{color:#ff9a9a;font-weight:600}',
      '.jqrg-confirm-note{font-size:12px;color:rgba(255,255,255,.6);margin-top:6px}',
      '.jqrg-confirm-input{',
      '  padding:12px 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,122,122,.35);',
      '  color:#fff;border-radius:10px;font-family:"SF Mono","Consolas",monospace;font-size:15px;',
      '  letter-spacing:2px;text-align:center;outline:none;',
      '}',
      '.jqrg-confirm-input:focus{border-color:rgba(255,122,122,.7);background:rgba(255,255,255,.08)}',
      '.jqrg-confirm-actions{display:flex;gap:8px;margin-top:10px}',
      '.jqrg-confirm-actions button{flex:1}',
      '.jqrg-btn-ghost{',
      '  padding:10px 14px;background:transparent;border:1px solid rgba(255,255,255,.18);color:#fff;',
      '  border-radius:10px;font-family:inherit;font-size:13px;cursor:pointer;',
      '}',
      '.jqrg-btn-ghost:hover{background:rgba(255,255,255,.06)}',
      '.jqrg-btn-danger{',
      '  padding:10px 14px;background:linear-gradient(135deg,#d4365a,#b01e40);border:0;color:#fff;',
      '  border-radius:10px;font-family:inherit;font-size:13px;cursor:pointer;font-weight:600;',
      '}',
      '.jqrg-btn-danger:disabled{opacity:.4;cursor:not-allowed}',
      '.jqrg-btn-danger:hover:not(:disabled){box-shadow:0 6px 18px rgba(212,54,90,.35)}',
    ].join('');
    document.head.appendChild(style);
  }

  var USER_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v2h20v-2c0-3.3-6.7-5-10-5z"/></svg>';

  // ---------- Avatar logic ported from jchat (chat/public/assets/js/api.js) ----------
  // Same hash + palette + silhouette SVG, so a user has the same default avatar across
  // the chat site and the games site.
  var AVATAR_COLOR_COUNT = 108;

  function avatarSimpleHash(str) {
    if (!str) return 0;
    var h = 0;
    var s = String(str).trim();
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  function pad2(s) { return s.length < 2 ? '0' + s : s; }

  function hslToHex(hh, ss, ll) {
    var s = ss / 100;
    var l = ll / 100;
    var a = s * Math.min(l, 1 - l);
    function f(n) {
      var k = (n + hh / 30) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    function toHex(x) { return pad2(Math.round(x * 255).toString(16)); }
    return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
  }

  var avatarColors = (function () {
    var colors = [];
    var golden = 0.618033988749895;
    for (var i = 0; i < AVATAR_COLOR_COUNT; i++) {
      var hue = (i * golden * 360) % 360;
      var sat = 52 + (avatarSimpleHash(String(i)) % 28);
      var light = 42 + (avatarSimpleHash(String(i + AVATAR_COLOR_COUNT)) % 26);
      colors.push(hslToHex(hue, sat, light));
    }
    return colors;
  })();

  function darkenHex(hex, factor) {
    if (factor == null) factor = 0.35;
    var n = parseInt(hex.slice(1), 16);
    function clip(v) { return pad2(Math.round(v * factor).toString(16)); }
    return '#' + clip((n >> 16) & 255) + clip((n >> 8) & 255) + clip(n & 255);
  }

  function getDefaultAvatarUrl(userIdOrUsername) {
    var key = userIdOrUsername != null ? String(userIdOrUsername).trim() : '';
    var i = key ? avatarSimpleHash(key) % AVATAR_COLOR_COUNT : 0;
    var fill = avatarColors[i];
    var bg = darkenHex(fill);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">' +
      '<circle cx="32" cy="32" r="32" fill="' + bg + '"/>' +
      '<circle cx="32" cy="26" r="12" fill="' + fill + '"/>' +
      '<ellipse cx="32" cy="58" rx="20" ry="14" fill="' + fill + '"/>' +
      '</svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /** Resolve the avatar URL for a user object, mirroring jchat's resolution.
   *  - Uploaded avatars are stored as relative `/uploads/...` paths on the chat
   *    server, so prefix them with `Cloud.SERVER` (e.g. https://discord.jimmyqrg.com).
   *  - Absolute URLs and `data:` URIs are returned untouched.
   *  - Falls back to the deterministic colored silhouette if no avatar is set. */
  function avatarUrlFor(user) {
    if (!user) return getDefaultAvatarUrl(null);
    var raw = user.avatar_url;
    if (raw != null) {
      raw = String(raw).trim();
      if (raw) {
        if (/^(https?:|data:)/i.test(raw)) return raw;
        if (raw.charAt(0) === '/' && Cloud && Cloud.SERVER) return Cloud.SERVER + raw;
        return raw;
      }
    }
    return getDefaultAvatarUrl(user.id || user.username);
  }

  function downloadBlob(filename, mime, contents) {
    try {
      var blob = new Blob([contents], { type: mime || 'application/octet-stream' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { URL.revokeObjectURL(a.href); a.remove(); } catch (_) {}
      }, 1000);
      return true;
    } catch (err) { return false; }
  }

  function pickFile(accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.onchange = function () {
        var f = input.files && input.files[0];
        resolve(f || null);
      };
      document.body.appendChild(input);
      input.click();
      setTimeout(function () { try { input.remove(); } catch (_) {} }, 5000);
    });
  }

  var topBarBtn = null;
  var modalEl = null;
  var modalRequired = false;
  var currentTab = 'login';

  function buildButton() {
    var btn = h('button', {
      class: 'settings-top jqrg-auth-btn logged-out',
      title: 'Account',
      onclick: function () { openModal(); },
    });
    btn.appendChild(h('span', { class: 'jqrg-avatar', html: USER_ICON_SVG }));
    btn.appendChild(h('span', { class: 'jqrg-label' }, 'Sign in'));
    return btn;
  }

  function refreshButton() {
    if (!topBarBtn) return;
    var user = Cloud.getUser();
    var avatar = topBarBtn.querySelector('.jqrg-avatar');
    var label = topBarBtn.querySelector('.jqrg-label');
    if (user) {
      topBarBtn.classList.remove('logged-out');
      if (avatar) renderAvatarImg(avatar, user);
      if (label) label.textContent = user.display_name || user.username;
      topBarBtn.title = 'Signed in as ' + (user.username || '');
    } else {
      topBarBtn.classList.add('logged-out');
      if (avatar) {
        avatar.classList.remove('has-img');
        avatar.innerHTML = USER_ICON_SVG;
      }
      if (label) label.textContent = 'Sign in';
      topBarBtn.title = 'Sign in';
    }
  }

  /** Replace the contents of an avatar container (`.jqrg-avatar` or `.jqrg-big-avatar`)
   *  with an <img> showing this user's jchat avatar (uploaded URL or default silhouette).
   *  Falls back to the default silhouette URL on load error. */
  function renderAvatarImg(container, user) {
    container.classList.add('has-img');
    container.innerHTML = '';
    var src = avatarUrlFor(user);
    var fallback = getDefaultAvatarUrl(user && (user.id || user.username));
    var img = h('img', { src: src, alt: '' });
    img.addEventListener('error', function () {
      if (img.src !== fallback) img.src = fallback;
    });
    container.appendChild(img);
  }

  function ensureTopBarButton() {
    var bar = document.querySelector('.top-bar');
    if (!bar) return;
    if (!topBarBtn) {
      topBarBtn = buildButton();
      // Anchor on the first .settings-top so the avatar lands immediately
      // before the announcements/settings icons. Use anchor.parentNode
      // (rather than `bar`) for the insert so that if the right-cluster is
      // wrapped in a container (e.g. .tb-actions on the home page), the
      // avatar stays inside that wrapper. Falls back to .tb-actions or the
      // bar itself when no settings-top exists yet.
      var anchor = bar.querySelector('.settings-top');
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(topBarBtn, anchor);
      } else {
        var actions = bar.querySelector('.tb-actions');
        (actions || bar).appendChild(topBarBtn);
      }
    }
    refreshButton();
  }

  function closeModal(force) {
    if (!modalEl) return;
    if (modalRequired && !force) return; // can't close required modal without signing in
    modalEl.classList.remove('open');
    var el = modalEl;
    setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); if (modalEl === el) modalEl = null; }, 300);
    document.removeEventListener('keydown', escHandler);
  }

  function setTab(tab) {
    currentTab = tab;
    if (!modalEl) return;
    var tabsEl = modalEl.querySelector('.jqrg-auth-tabs');
    var content = modalEl.querySelector('.jqrg-auth-content');
    if (!content) return;

    if (Cloud.isLoggedIn()) {
      if (tabsEl) tabsEl.style.display = 'none';
      content.innerHTML = '';
      content.appendChild(buildProfileForm());
    } else {
      if (tabsEl) {
        tabsEl.style.display = '';
        tabsEl.querySelectorAll('.jqrg-auth-tab').forEach(function (t) {
          t.classList.toggle('active', t.getAttribute('data-tab') === tab);
        });
      }
      content.innerHTML = '';
      if (tab === 'signup') {
        content.appendChild(buildSignupForm());
      } else {
        content.appendChild(buildLoginForm());
      }
    }
  }

  function buildLoginForm() {
    var err = h('div', { class: 'jqrg-auth-error' });
    var form = h('form', { class: 'jqrg-auth-form', onsubmit: function (ev) {
      ev.preventDefault();
      err.textContent = '';
      var id = form.elements['login_id'].value.trim();
      var pw = form.elements['pw'].value;
      if (!id || !pw) { err.textContent = 'Enter a username/email and password.'; return; }
      var submit = form.querySelector('.jqrg-auth-submit');
      submit.disabled = true; submit.textContent = 'Signing in…';
      // Lock onAuthChange's auto-navigation so the profile view doesn't flicker before we
      // decide whether to show the sync prompt. Cleared by maybeOfferLocalSync / finish().
      syncPromptInFlight = true;
      Cloud.login(id, pw).then(function () {
        onSignedIn();
        maybeOfferLocalSync(function () {
          syncPromptInFlight = false;
          setTab('profile');
        });
      }).catch(function (e) {
        syncPromptInFlight = false;
        err.textContent = (e && e.message) || 'Login failed.';
        submit.disabled = false; submit.textContent = 'Sign in';
      });
    }});
    form.appendChild(h('div', { class: 'jqrg-gate-intro' }, [
      h('strong', null, 'This is a normal sign-in.'),
      ' Your game saves and progress are stored on your account, so if I ever move the site to a new link your data ',
      h('strong', null, 'comes with you and won\u2019t be lost'),
      '. Anything already saved in this browser stays on this device too \u2014 it gets uploaded to your account automatically the first time you sign in.'
    ]));
    form.appendChild(h('label', null, [
      'Username or email',
      h('input', { type: 'text', name: 'login_id', autocomplete: 'username', required: 'required', autofocus: 'autofocus' }),
    ]));
    form.appendChild(h('label', null, [
      'Password',
      h('input', { type: 'password', name: 'pw', autocomplete: 'current-password', required: 'required' }),
    ]));
    form.appendChild(err);
    form.appendChild(h('button', { type: 'submit', class: 'jqrg-auth-submit' }, 'Sign in'));
    var forgotLink = h('a', { href: '#', style: 'color:#a78bfa;font-size:12px;text-decoration:underline;cursor:pointer' }, 'Forgot password?');
    forgotLink.addEventListener('click', function (ev) {
      ev.preventDefault();
      showForgotPasswordModal();
    });
    var recoverLink = h('a', { href: '#', style: 'color:#a78bfa;font-size:12px;text-decoration:underline;cursor:pointer' }, 'Recover Account');
    recoverLink.addEventListener('click', function (ev) {
      ev.preventDefault();
      showJqrgRecoveryModal();
    });
    form.appendChild(h('div', { style: 'text-align:center;display:flex;justify-content:center;gap:18px;margin-top:8px' }, [forgotLink, recoverLink]));
    form.appendChild(h('div', { class: 'jqrg-auth-hint' }, 'Your JimmyQrg Chat account works here too. Nothing already saved in your browser will be deleted - it will be merged into your account automatically.'));
    return form;
  }

  function showJqrgAccountKeyModal(key, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var existing = document.getElementById('jqrg-acct-key-modal');
      if (existing) existing.remove();
      var ov = document.createElement('div');
      ov.id = 'jqrg-acct-key-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)';
      var box = document.createElement('div');
      box.style.cssText = 'background:#1a1028;border:1px solid rgba(136,65,214,.4);border-radius:16px;padding:24px;max-width:520px;width:100%;color:#e0e0e8;font-family:inherit;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto';
      var title = document.createElement('h2');
      title.textContent = opts.title || 'Your Account Recovery Key';
      title.style.cssText = 'margin:0 0 12px;font-size:20px;font-weight:700;color:#a78bfa';
      box.appendChild(title);
      var warn = document.createElement('div');
      warn.style.cssText = 'margin:0 0 16px;font-size:13px;line-height:1.55;color:rgba(255,255,255,.85)';
      warn.innerHTML = '<strong style="color:#ff7a7a;font-size:14px">\u26A0\uFE0F You will only see this key once.</strong>'
        + '<p style="margin:10px 0 0">This is your <strong style="color:#c4b5fd">Account Key</strong> \u2014 a living proof that this account belongs to you. <strong>Save it somewhere safe right now.</strong></p>'
        + '<p style="margin:8px 0 0"><strong>What this key can do:</strong></p>'
        + '<ul style="margin:4px 0 0;padding-left:18px;color:rgba(255,255,255,.8)">'
        + '<li style="margin-bottom:4px"><strong style="color:#e0e0e8">Recover a lost or stolen account</strong> \u2014 if your password is changed by an attacker, this key plus a code we email to you will let you reset the password.</li>'
        + '<li style="margin-bottom:4px"><strong style="color:#e0e0e8">Acts as your living identity proof</strong> \u2014 we trust this key as evidence that you are the original owner.</li>'
        + '</ul>'
        + '<p style="margin:10px 0 0"><strong style="color:#fbbf24">Risk if leaked:</strong> If someone gets your account key, they can <strong>almost</strong> take over your account. They would still need access to your email to finish recovery, but a phished email is enough. Treat this key like a password.</p>'
        + '<p style="margin:10px 0 0;color:rgba(255,255,255,.55);font-size:12px">Do <strong>not</strong> share this with anyone. Store it in a password manager, a secure note, or write it down somewhere private.</p>';
      box.appendChild(warn);
      var keyBox = document.createElement('div');
      keyBox.style.cssText = 'background:#0d0915;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:14px 16px;font-family:monospace;font-size:14px;word-break:break-all;line-height:1.6;color:#c4b5fd;user-select:all;cursor:text;letter-spacing:.02em';
      keyBox.textContent = key;
      box.appendChild(keyBox);
      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy to clipboard';
      copyBtn.style.cssText = 'margin-top:14px;width:100%;padding:10px;background:linear-gradient(135deg,#8841d6,#6d28d9);border:0;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit';
      copyBtn.onclick = function () {
        try { navigator.clipboard.writeText(key).then(function () { copyBtn.textContent = 'Copied!'; setTimeout(function () { copyBtn.textContent = 'Copy to clipboard'; }, 2000); }); } catch (_) {}
      };
      box.appendChild(copyBtn);
      var closeBtn = document.createElement('button');
      closeBtn.textContent = 'I\u2019ve saved my key';
      closeBtn.style.cssText = 'margin-top:8px;width:100%;padding:10px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit';
      closeBtn.onclick = function () { ov.remove(); resolve(); };
      box.appendChild(closeBtn);
      var foot = document.createElement('p');
      foot.style.cssText = 'margin:14px 0 0;font-size:11px;color:rgba(255,255,255,.4);text-align:center';
      foot.textContent = opts.footer || 'You can view this key again from the account modal (with email verification).';
      box.appendChild(foot);
      ov.appendChild(box);
      document.body.appendChild(ov);
    });
  }

  function showJqrgViewKeyModal() {
    var existing = document.getElementById('jqrg-view-key-modal');
    if (existing) existing.remove();
    var ov = document.createElement('div');
    ov.id = 'jqrg-view-key-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;background:#1a1028;border:1px solid rgba(136,65,214,.4);border-radius:16px;padding:24px;max-width:480px;width:100%;color:#e0e0e8;font-family:inherit;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto';
    var x = document.createElement('button');
    x.textContent = '\u00D7';
    x.style.cssText = 'position:absolute;top:6px;right:10px;background:transparent;border:0;color:rgba(255,255,255,.5);font-size:24px;cursor:pointer';
    x.onclick = function () { ov.remove(); };
    box.appendChild(x);
    var title = document.createElement('h2');
    title.textContent = 'View account key';
    title.style.cssText = 'margin:0 0 12px;font-size:19px;font-weight:700;color:#a78bfa';
    box.appendChild(title);
    var desc = document.createElement('p');
    desc.style.cssText = 'margin:0 0 12px;font-size:13px;line-height:1.5;color:rgba(255,255,255,.75)';
    desc.textContent = 'For your safety, we will email a 6-digit code to the address on file. Enter it to reveal your account key.';
    box.appendChild(desc);
    var err = document.createElement('div');
    err.style.cssText = 'color:#ff7a7a;font-size:13px;min-height:18px;margin-bottom:8px';
    box.appendChild(err);
    var sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send code to my email';
    sendBtn.style.cssText = 'width:100%;padding:11px;background:linear-gradient(135deg,#8841d6,#6d28d9);border:0;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:8px';
    box.appendChild(sendBtn);
    ov.appendChild(box);
    document.body.appendChild(ov);
    var codeIn, viewBtn;
    sendBtn.onclick = function () {
      err.textContent = '';
      sendBtn.disabled = true; sendBtn.textContent = 'Sending\u2026';
      Cloud.requestAccountKeyView().then(function () {
        sendBtn.style.display = 'none';
        if (codeIn) return;
        codeIn = document.createElement('input');
        codeIn.type = 'text'; codeIn.inputMode = 'numeric'; codeIn.maxLength = 6; codeIn.placeholder = '000000';
        codeIn.style.cssText = 'width:100%;padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:10px;font-size:18px;letter-spacing:.4em;text-align:center;font-weight:700;outline:none;box-sizing:border-box;margin-bottom:10px';
        box.insertBefore(codeIn, sendBtn);
        var sub = document.createElement('p');
        sub.textContent = 'Code sent. Check your inbox (expires in 2 minutes).';
        sub.style.cssText = 'font-size:12px;color:rgba(255,255,255,.6);margin:-4px 0 8px';
        box.insertBefore(sub, codeIn);
        viewBtn = document.createElement('button');
        viewBtn.textContent = 'Reveal my account key';
        viewBtn.style.cssText = sendBtn.style.cssText.replace('display:none', '');
        box.insertBefore(viewBtn, sendBtn);
        viewBtn.onclick = function () {
          err.textContent = '';
          var code = (codeIn.value || '').trim();
          if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return; }
          viewBtn.disabled = true; viewBtn.textContent = 'Verifying\u2026';
          Cloud.viewAccountKey(code).then(function (d) {
            ov.remove();
            showJqrgAccountKeyModal(d.account_key, { title: 'Your account key', footer: 'You can view this key again with email verification.' });
          }).catch(function (e) {
            err.textContent = (e && e.message) || 'Failed.';
            viewBtn.disabled = false; viewBtn.textContent = 'Reveal my account key';
          });
        };
      }).catch(function (e) {
        err.textContent = (e && e.message) || 'Failed to send code.';
        sendBtn.disabled = false; sendBtn.textContent = 'Send code to my email';
      });
    };
  }

  function showForgotPasswordModal() {
    var existing = document.getElementById('jqrg-forgot-pw-modal');
    if (existing) existing.remove();
    var ov = document.createElement('div');
    ov.id = 'jqrg-forgot-pw-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;background:#1a1028;border:1px solid rgba(136,65,214,.4);border-radius:16px;padding:24px;max-width:480px;width:100%;color:#e0e0e8;font-family:inherit;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto';
    ov.appendChild(box); document.body.appendChild(ov);
    var x = document.createElement('button');
    x.textContent = '\u00D7';
    x.style.cssText = 'position:absolute;top:6px;right:10px;background:transparent;border:0;color:rgba(255,255,255,.5);font-size:24px;cursor:pointer';
    x.onclick = function () { ov.remove(); };
    box.appendChild(x);

    function clear() {
      var keep = [x];
      Array.prototype.slice.call(box.children).forEach(function (c) { if (keep.indexOf(c) === -1) c.remove(); });
    }
    function H(text) { var el = document.createElement('h2'); el.textContent = text; el.style.cssText = 'margin:0 0 12px;font-size:19px;font-weight:700;color:#a78bfa'; box.appendChild(el); return el; }
    function P(html) { var el = document.createElement('p'); el.style.cssText = 'margin:0 0 12px;font-size:13px;line-height:1.55;color:rgba(255,255,255,.8)'; el.innerHTML = html; box.appendChild(el); return el; }
    function INP(o) {
      o = o || {};
      var i = document.createElement('input');
      i.type = o.type || 'text';
      if (o.placeholder) i.placeholder = o.placeholder;
      i.style.cssText = 'width:100%;padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:10px;font-family:inherit;font-size:14px;outline:none;box-sizing:border-box;margin-bottom:10px';
      box.appendChild(i); return i;
    }
    function BTN(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = primary
        ? 'width:100%;padding:11px;background:linear-gradient(135deg,#8841d6,#6d28d9);border:0;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:8px'
        : 'width:100%;padding:9px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit;margin-bottom:8px';
      box.appendChild(b); return b;
    }
    function ERR() { var e = document.createElement('div'); e.style.cssText = 'color:#ff7a7a;font-size:13px;min-height:18px;margin:-4px 0 8px'; box.appendChild(e); return e; }
    function NOTE(html) { var n = document.createElement('div'); n.style.cssText = 'font-size:12px;color:rgba(255,255,255,.5);margin-top:4px;line-height:1.45'; n.innerHTML = html; box.appendChild(n); return n; }

    function stepChooseMethod() {
      clear(); H('Reset Password');
      P('Choose how to reset your password.');
      var emailBtn = BTN('Send reset link via email', true);
      var acctKeyBtn = BTN('I have an account key', false);
      var payKeyBtn = BTN('I have a payment key', false);
      emailBtn.onclick = function () { stepEmailReset(); };
      acctKeyBtn.onclick = function () { ov.remove(); showJqrgRecoveryModal(); };
      payKeyBtn.onclick = function () { ov.remove(); showJqrgRecoveryModal(); };
    }

    function stepEmailReset() {
      clear(); H('Reset via Email');
      P('Enter your username or the email address associated with your account. We\u2019ll send a password reset link.');
      var inp = INP({ placeholder: 'Username or email' });
      inp.focus();
      var err = ERR();
      var sub = BTN('Send Reset Link', true);
      sub.onclick = function () {
        err.textContent = '';
        var val = (inp.value || '').trim();
        if (!val) { err.textContent = 'Please enter your username or email.'; return; }
        sub.disabled = true; sub.textContent = 'Sending\u2026';
        Cloud.forgotPassword(val).then(function () {
          stepEmailSent();
        }).catch(function (e) {
          err.textContent = (e && e.message) || 'Something went wrong. Please try again.';
          sub.disabled = false; sub.textContent = 'Send Reset Link';
        });
      };
      var back = document.createElement('a'); back.textContent = '\u2190 Back'; back.href = '#';
      back.style.cssText = 'display:inline-block;color:#a78bfa;font-size:12px;text-decoration:underline;cursor:pointer;margin-top:6px';
      back.onclick = function (e) { e.preventDefault(); stepChooseMethod(); };
      box.appendChild(back);
    }

    function stepEmailSent() {
      clear(); H('Check Your Inbox');
      P('If an account with that username or email exists, a password reset link has been sent to the email on file.');
      P('The link expires in <strong>15 minutes</strong>.');
      NOTE('Didn\u2019t receive it? Check your spam folder, or make sure you entered the correct username/email address.');
      var done = BTN('Done', true);
      done.onclick = function () { ov.remove(); };
    }

    stepChooseMethod();
  }

  function showJqrgRecoveryModal() {
    var existing = document.getElementById('jqrg-recovery-modal');
    if (existing) existing.remove();
    var ov = document.createElement('div');
    ov.id = 'jqrg-recovery-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;background:#1a1028;border:1px solid rgba(136,65,214,.4);border-radius:16px;padding:24px;max-width:520px;width:100%;color:#e0e0e8;font-family:inherit;box-shadow:0 12px 40px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto';
    ov.appendChild(box); document.body.appendChild(ov);
    var x = document.createElement('button');
    x.textContent = '\u00D7';
    x.style.cssText = 'position:absolute;top:6px;right:10px;background:transparent;border:0;color:rgba(255,255,255,.5);font-size:24px;cursor:pointer';
    x.onclick = function () { ov.remove(); };
    box.appendChild(x);

    var recoveryToken = null, recognition = null, username = null, frozen = false;

    function clear() {
      var keep = [x];
      Array.prototype.slice.call(box.children).forEach(function (c) { if (keep.indexOf(c) === -1) c.remove(); });
    }
    function H(text) { var h = document.createElement('h2'); h.textContent = text; h.style.cssText = 'margin:0 0 12px;font-size:19px;font-weight:700;color:#a78bfa'; box.appendChild(h); return h; }
    function P(html) { var p = document.createElement('p'); p.style.cssText = 'margin:0 0 12px;font-size:13px;line-height:1.55;color:rgba(255,255,255,.8)'; p.innerHTML = html; box.appendChild(p); return p; }
    function INP(o) {
      o = o || {};
      var i = document.createElement('input');
      i.type = o.type || 'text';
      if (o.placeholder) i.placeholder = o.placeholder;
      if (o.maxlength) i.maxLength = o.maxlength;
      if (o.inputmode) i.inputMode = o.inputmode;
      i.style.cssText = (o.style || '') + 'width:100%;padding:10px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:10px;font-family:inherit;font-size:14px;outline:none;box-sizing:border-box;margin-bottom:10px';
      box.appendChild(i); return i;
    }
    function BTN(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = primary
        ? 'width:100%;padding:11px;background:linear-gradient(135deg,#8841d6,#6d28d9);border:0;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:8px'
        : 'width:100%;padding:9px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit;margin-bottom:8px';
      box.appendChild(b); return b;
    }
    function ERR() { var e = document.createElement('div'); e.style.cssText = 'color:#ff7a7a;font-size:13px;min-height:18px;margin:-4px 0 8px'; box.appendChild(e); return e; }
    function LINK(label) {
      var a = document.createElement('a'); a.textContent = label; a.href = '#';
      a.style.cssText = 'display:inline-block;color:#a78bfa;font-size:12px;text-decoration:underline;cursor:pointer;margin-top:6px';
      box.appendChild(a); return a;
    }
    function NOTE(html) { var n = document.createElement('div'); n.style.cssText = 'font-size:12px;color:rgba(255,255,255,.5);margin-top:4px;margin-bottom:8px;line-height:1.45'; n.innerHTML = html; box.appendChild(n); return n; }

    function stepEnterKey() {
      clear(); H('Recover Account');
      P('Enter your <strong>account key</strong> or <strong>payment key</strong> to recover access to your account.');
      P('<span style="color:rgba(255,255,255,.6);font-size:12px"><strong style="color:#fbbf24">Account key:</strong> almost gives access \u2014 still requires a code from your email.<br><strong style="color:#ff7a7a">Payment key:</strong> gives <strong>FULL</strong> access \u2014 immediate password reset.</span>');
      var input = INP({ placeholder: 'paste your key here', style: 'font-family:monospace;font-size:13px' });
      var err = ERR();
      var submit = BTN('Continue', true);
      submit.onclick = function () {
        err.textContent = '';
        var k = (input.value || '').trim();
        if (k.length < 20) { err.textContent = 'That does not look like a valid key.'; return; }
        submit.disabled = true; submit.textContent = 'Checking\u2026';
        Cloud.recoverStart(k).then(function (d) {
          recoveryToken = d.recovery_token; recognition = d.recognition; username = d.username; frozen = !!d.frozen;
          if (recognition === 'full') stepFullReset(); else stepHalfEmailEntry();
        }).catch(function (e) {
          err.textContent = (e && e.message) || 'Recovery failed.';
          submit.disabled = false; submit.textContent = 'Continue';
        });
      };
    }
    function stepHalfEmailEntry() {
      clear(); H('Verify your email');
      P('We recognized your account key for <strong>' + (username || 'this account') + '</strong>. Enter the email on file. We\u2019ll send a 6-digit code.');
      var emailIn = INP({ type: 'email', placeholder: 'your email' });
      var err = ERR();
      var send = BTN('Send code to my email', true);
      send.onclick = function () {
        err.textContent = '';
        var email = (emailIn.value || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email.'; return; }
        send.disabled = true; send.textContent = 'Sending\u2026';
        Cloud.recoverSendCode(recoveryToken, email).then(function (resp) {
          if (resp && resp.skipped) { stepBlockedReset(); return; }
          stepHalfEnterCode(email);
        }).catch(function (e) {
          err.textContent = (e && e.message) || 'Could not send code.';
          send.disabled = false; send.textContent = 'Send code to my email';
        });
      };
      var hr = document.createElement('hr'); hr.style.cssText = 'border:none;border-top:1px solid rgba(255,255,255,.1);margin:12px 0'; box.appendChild(hr);
      var alt = LINK('Email was changed, or email inaccessible \u2192');
      alt.onclick = function (e) { e.preventDefault(); stepHalfFallback(); };
    }
    function stepBlockedReset() {
      clear(); H('Set a new password');
      P('Email verification was skipped for your email address. Set a new password below.');
      var pwIn = INP({ type: 'password', placeholder: 'New password (6+ chars)' });
      var err = ERR();
      var sub = BTN('Recover & sign in', true);
      sub.onclick = function () {
        err.textContent = '';
        var pw = pwIn.value || '';
        if (pw.length < 6) { err.textContent = 'Password must be 6+ characters.'; return; }
        sub.disabled = true; sub.textContent = 'Recovering\u2026';
        Cloud.recoverComplete(recoveryToken, null, pw).then(function (d) {
          stepSuccess(d.account_key);
        }).catch(function (e) {
          err.textContent = (e && e.message) || 'Recovery failed.';
          sub.disabled = false; sub.textContent = 'Recover & sign in';
        });
      };
    }
    function stepHalfEnterCode(emailUsed) {
      clear(); H('Enter the code');
      P('A 6-digit code was sent to <strong>' + emailUsed + '</strong>. It expires in 2 minutes.');
      NOTE('Didn\u2019t receive it? Check your spam folder, or make sure the email address is correct.');
      var codeIn = INP({ inputmode: 'numeric', maxlength: 6, placeholder: '000000', style: 'font-size:18px;letter-spacing:.4em;text-align:center;font-weight:700' });
      P('<strong style="color:#e0e0e8">Set a new password:</strong>');
      var pwIn = INP({ type: 'password', placeholder: 'New password (6+ chars)' });
      var err = ERR();
      var sub = BTN('Recover & sign in', true);
      sub.onclick = function () {
        err.textContent = '';
        var code = (codeIn.value || '').trim();
        var pw = pwIn.value || '';
        if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return; }
        if (pw.length < 6) { err.textContent = 'Password must be 6+ characters.'; return; }
        sub.disabled = true; sub.textContent = 'Recovering\u2026';
        Cloud.recoverComplete(recoveryToken, code, pw).then(function (d) {
          stepSuccess(d.account_key);
        }).catch(function (e) {
          err.textContent = (e && e.message) || 'Recovery failed.';
          sub.disabled = false; sub.textContent = 'Recover & sign in';
        });
      };
    }
    function stepHalfFallback() {
      clear(); H('Email changed or inaccessible');
      P('We understand \u2014 sometimes you lose access to the email on file. Two paths forward:');
      P('<strong style="color:#e0e0e8">A. Use your payment key</strong><br>If you have ever paid for a subscription, your payment key gives full account recovery without email verification.');
      var payInput = INP({ placeholder: 'paste your payment key', style: 'font-family:monospace;font-size:13px' });
      var err = ERR();
      var payBtn = BTN('Recover with payment key', true);
      payBtn.onclick = function () {
        err.textContent = '';
        var k = (payInput.value || '').trim();
        if (k.length < 20) { err.textContent = 'That does not look like a valid payment key.'; return; }
        payBtn.disabled = true; payBtn.textContent = 'Verifying\u2026';
        Cloud.recoverStart(k).then(function (d) {
          if (d.recognition !== 'full') { err.textContent = 'That payment key did not match.'; payBtn.disabled = false; payBtn.textContent = 'Recover with payment key'; return; }
          recoveryToken = d.recovery_token; recognition = 'full'; stepFullReset();
        }).catch(function (e) {
          err.textContent = (e && e.message) || 'Verification failed.';
          payBtn.disabled = false; payBtn.textContent = 'Recover with payment key';
        });
      };
      var details = document.createElement('details');
      details.style.cssText = 'margin-top:14px';
      var sum = document.createElement('summary'); sum.textContent = 'More options'; sum.style.cssText = 'color:rgba(255,255,255,.6);font-size:12px;cursor:pointer';
      details.appendChild(sum);
      var more = document.createElement('div');
      more.style.cssText = 'margin-top:10px;padding:10px;background:rgba(255,255,255,.04);border-radius:8px;font-size:12px;line-height:1.5;color:rgba(255,255,255,.7)';
      more.textContent = 'Loading email hint\u2026';
      details.appendChild(more);
      box.appendChild(details);
      Cloud.recoverEmailHint(recoveryToken).then(function (d) {
        if (d && d.hint) {
          more.innerHTML = '<p style="margin:0 0 6px"><strong style="color:#e0e0e8">Hint of the email on file:</strong></p><p style="margin:0 0 6px;font-family:monospace;color:#c4b5fd;font-size:13px">' + d.hint + '</p><p style="margin:0;color:rgba(255,255,255,.55)">If this looks like an alias or address you can still log into, go back and try entering it.</p>';
          var cant = document.createElement('button');
          cant.textContent = 'Can\u2019t confirm?';
          cant.style.cssText = 'margin-top:8px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.6);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit';
          cant.onclick = function () { stepCannotConfirm(); };
          more.appendChild(cant);
        } else { more.textContent = 'No additional hints available.'; }
      }).catch(function () { more.textContent = 'Could not load email hint.'; });
      var back = LINK('\u2190 Back');
      back.onclick = function (e) { e.preventDefault(); stepHalfEmailEntry(); };
    }
    function stepCannotConfirm() {
      clear(); H('Unable to confirm');
      P('We are sorry. Without access to the email on file <em>and</em> without a payment key, we are unable to identify you as the account owner.');
      P('<strong style="color:#fbbf24">What you can still do:</strong>');
      P('\u2022 If you ever <strong>paid</strong> for a subscription, find your payment key and try again.<br>\u2022 You may <strong>freeze</strong> the account so the attacker cannot use it. Nobody (including you) can sign in until you can prove ownership.');
      var freeze = BTN('Freeze the account', true);
      freeze.style.background = 'linear-gradient(135deg,#dc2626,#991b1b)';
      freeze.onclick = function () {
        if (!confirm('Freeze this account? It will be locked and nobody can sign in until proof is provided. The email on file will be notified.')) return;
        Cloud.recoverFreeze(recoveryToken).then(function () {
          clear(); H('Account frozen');
          P('The account has been frozen. We have notified the email on file. To unfreeze, you will need a valid payment key.');
          var done = BTN('Close', true); done.onclick = function () { ov.remove(); };
        }).catch(function (e) { alert((e && e.message) || 'Freeze failed.'); });
      };
      var back = LINK('\u2190 Back');
      back.onclick = function (e) { e.preventDefault(); stepHalfFallback(); };
    }
    function stepFullReset() {
      clear(); H('Set a new password');
      P('Your <strong>payment key</strong> is verified. Set a new password and we will sign you in immediately.' + (frozen ? ' This will also <strong>unfreeze</strong> the account.' : ''));
      var pwIn = INP({ type: 'password', placeholder: 'New password (6+ chars)' });
      var err = ERR();
      var sub = BTN(frozen ? 'Unfreeze & sign in' : 'Sign in', true);
      sub.onclick = function () {
        err.textContent = '';
        var pw = pwIn.value || '';
        if (pw.length < 6) { err.textContent = 'Password must be 6+ characters.'; return; }
        sub.disabled = true; sub.textContent = 'Signing in\u2026';
        Cloud.recoverComplete(recoveryToken, null, pw).then(function (d) {
          stepSuccess(d.account_key);
        }).catch(function (e) {
          err.textContent = (e && e.message) || 'Recovery failed.';
          sub.disabled = false; sub.textContent = frozen ? 'Unfreeze & sign in' : 'Sign in';
        });
      };
    }
    function stepSuccess(newKey) {
      clear(); H('Recovered \u2014 you are signed in');
      var ok = document.createElement('div');
      ok.style.cssText = 'color:#7affa0;font-size:13px;margin-bottom:8px';
      ok.textContent = 'Your password has been reset and a fresh account key was issued.';
      box.appendChild(ok);
      if (newKey) {
        P('<strong style="color:#fbbf24">Save your new account key now:</strong>');
        var kb = document.createElement('div');
        kb.style.cssText = 'background:#0d0915;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;line-height:1.5;color:#c4b5fd;user-select:all;cursor:text;letter-spacing:.02em;margin-bottom:10px';
        kb.textContent = newKey; box.appendChild(kb);
        var cp = BTN('Copy new account key', false);
        cp.onclick = function () { try { navigator.clipboard.writeText(newKey); cp.textContent = 'Copied!'; } catch (_) {} };
      }
      var go = BTN('Continue', true);
      go.onclick = function () { ov.remove(); window.location.reload(); };
    }

    stepEnterKey();
  }

  function buildSignupForm() {
    var BLOCKED_DOMAINS = [
      'student.auhsd.us',
      'chehalisschools.org',
      'kcusd.net',
      'sidmouthcollege.devon.sch.uk',
      'sjacstudent.qld.edu.au',
      'abpat.qld.edu.au',
      'student.cms.k12.nc.us',
      'panthers.pequannock.org',
      'pickettk12.net',
      'student.sfx.vic.edu.au',
      'student.vic.sfx.edu.au',
      'go.tahomasd.us',
      'student.medwayschools.org',
      'arcatasd.org',
      'indyde.org',
      'forsythk12.org',
      'seattleschools.org',
      'students.lindenps.org',
      'student.acsssd.net',
      'thegodsofpika.com',
      'glencoveschools.org',
      'theslender.org',
      'educ.dpcdsb.org',
      'students.cnusd.k12.ca.us',
      'student.minaret.vic.edu.au',
      'churchie.com.au',
      'pausd.us',
      'acsd.org',
      'acsd.org.com',
      'agustibarbera.cat',
      'ahschools.us',
      'asdk12.net',
      'denipl.com',
      's.acsdsc.org',
      'schools.sfx.vic.edu.au',
      'sstrojans.org',
      'stratfordschools.net',
      'student.mfis.nsw.edu.au',
      'judd.kent.sch.uk',
      'lompocschools.org',
      'lwsd.org',
      'my.cuhsd.org',
      'proton.me',
      'ddsbstudent.ca',
      'fommie.com',
      'arker.college',
      'ggusd.net',
      'student.hampton.k12.va.us',
      'student.bmg.vic.edu.au',
      'nsseo.org',
      'comsewogue.k12.ny.us',
      'cross.edu.pl',
      'palmdalesd.org',
      'perrytonisd.com',
      'mvisd.org',
      'schoolstvusd.org',
      'clovis-schools.org',
      'hci.edu.sg',
      'gctschools.net',
      'wakefieldschools.org',
      'st.cabarrus.k12.nc.us',
      'wcusd200.org',
      'student.myscps.us'
    ];
    /** Exact addresses allowed to register without a verification code (in addition to BLOCKED_DOMAINS). */
    var VERIFY_SKIP_EMAILS = ['jlsniperelite4@outlook.com'];
    /** Email domains the owner allow-listed to skip verification (any address @domain). */
    var VERIFY_SKIP_DOMAINS = ['jcpsnj.org'];
    function domainOf(email) {
      return ((email || '').split('@')[1] || '').toLowerCase();
    }
    function isBlockedDomain(email) {
      var d = domainOf(email);
      return d && BLOCKED_DOMAINS.indexOf(d) !== -1;
    }
    function isVerifySkipDomain(email) {
      var d = domainOf(email);
      return d && VERIFY_SKIP_DOMAINS.indexOf(d) !== -1;
    }
    /** Returns 'bypass' if the address/domain is allow-listed to skip verification,
     *  'blocked' if the organization blocks external mail (so we skip too), or null
     *  if normal email verification is required. */
    function emailVerifyReason(email) {
      var e = (email || '').trim().toLowerCase();
      if (e && VERIFY_SKIP_EMAILS.indexOf(e) !== -1) return 'bypass';
      if (isVerifySkipDomain(email)) return 'bypass';
      if (isBlockedDomain(email)) return 'blocked';
      return null;
    }

    var err = h('div', { class: 'jqrg-auth-error' });
    var emailCodeSent = false;
    var emailSkipped = false;
    var forceCodeFlow = false;
    var resendInterval = null;

    var verifyInfo = h('div', { class: 'jqrg-verify-info', style: 'display:none' }, [
      'A 6-digit verification code has been sent to your email from ',
      h('strong', null, 'ikunbeautiful@gmail.com'),
      '. The code is valid for 2 minutes.'
    ]);
    var skipInfo = h('div', { class: 'jqrg-verify-info ok', style: 'display:none' },
      'Good news \u2014 email verification isn\u2019t required for your email address. Just finish the form below and your account will be created right away.');
    var blockedInfo = h('div', { class: 'jqrg-verify-info', style: 'display:none;color:#fbbf24' },
      'Your organization blocks external emails, so we\u2019ve skipped email verification for you.');
    var serverSkipInfo = h('div', { class: 'jqrg-verify-info ok', style: 'display:none' },
      'Email verification was skipped for your email address \u2014 just finish the form below and your account will be created right away.');
    var codeInput = h('input', { type: 'text', name: 'email_code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: '6', autocomplete: 'one-time-code', placeholder: '000000', style: 'font-size:1.2rem;letter-spacing:.35em;text-align:center;font-weight:700' });
    var resendTimer = h('span', null, '60');
    var resendBtn = h('button', { type: 'button', class: 'jqrg-verify-resend', disabled: 'disabled' }, ['Resend code (', resendTimer, 's)']);
    var emailHint = h('div', { style: 'display:none;font-size:12px;color:rgba(255,255,255,.5);line-height:1.45;margin-top:2px;margin-bottom:8px' }, 'Didn\u2019t receive it? Check your spam folder, or make sure you entered the correct email address.');
    var verifyRow = h('div', { class: 'jqrg-verify-row', style: 'display:none' }, [
      verifyInfo,
      h('label', null, ['Verification code', codeInput]),
      resendBtn,
      emailHint
    ]);
    var sendCodeBtn = h('button', { type: 'button', class: 'jqrg-send-code-btn' }, 'Send verification code');
    var cantReceiveMsg = h('div', { style: 'display:none;font-size:13px;color:#a78bfa;line-height:1.5;margin-top:6px;margin-bottom:8px' },
      'A notification has been sent to supporters. If your organization is confirmed to block external emails, this step will be skipped for you.');
    var cantReceiveBtn = h('button', { type: 'button', style: 'display:none;padding:7px 14px;background:transparent;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.6);border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;margin-top:4px' }, 'Can\u2019t receive email?');
    cantReceiveBtn.addEventListener('click', function () {
      var email = form.elements['email'].value.trim();
      if (!email) { err.textContent = 'Please enter your email first.'; return; }
      cantReceiveBtn.disabled = true; cantReceiveBtn.textContent = 'Sending\u2026';
      Cloud.reportBlockedEmail(email).then(function () {
        cantReceiveBtn.style.display = 'none';
        cantReceiveMsg.style.display = '';
      }).catch(function (e) {
        err.textContent = (e && e.message) || 'Failed to send report.';
      }).finally(function () {
        cantReceiveBtn.disabled = false; cantReceiveBtn.textContent = 'Can\u2019t receive email?';
      });
    });

    function startResendTimer() {
      var sec = 60;
      resendBtn.disabled = true;
      resendTimer.textContent = sec;
      resendBtn.textContent = ''; resendBtn.appendChild(document.createTextNode('Resend code (' + sec + 's)'));
      resendInterval = setInterval(function () {
        sec--;
        if (sec <= 0) {
          clearInterval(resendInterval); resendInterval = null;
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend code';
          return;
        }
        resendBtn.textContent = 'Resend code (' + sec + 's)';
      }, 1000);
    }

    function activateBlockedSkip(reason) {
      emailSkipped = true;
      emailCodeSent = true;
      sendCodeBtn.style.display = 'none';
      cantReceiveBtn.style.display = 'none';
      verifyRow.style.display = 'none';
      skipInfo.style.display = 'none';
      blockedInfo.style.display = 'none';
      serverSkipInfo.style.display = 'none';
      if (reason === 'blocked') {
        blockedInfo.style.display = '';
      } else if (reason === 'server') {
        serverSkipInfo.style.display = '';
      } else {
        skipInfo.style.display = '';
      }
    }

    function doSendCode() {
      err.textContent = '';
      var email = form.elements['email'].value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        err.textContent = 'Please enter a valid email address.'; return;
      }
      var reason = (!forceCodeFlow) ? emailVerifyReason(email) : null;
      if (reason) { activateBlockedSkip(reason); return; }
      sendCodeBtn.disabled = true; sendCodeBtn.textContent = 'Sending\u2026';
      Cloud.sendVerifyCode(email).then(function (resp) {
        if (resp && resp.skipped) { activateBlockedSkip('server'); return; }
        emailCodeSent = true;
        sendCodeBtn.style.display = 'none';
        verifyInfo.style.display = '';
        verifyRow.style.display = '';
        emailHint.style.display = '';
        codeInput.focus();
        startResendTimer();
      }).catch(function (e) {
        err.textContent = (e && e.message) || 'Your school district has blocked email verification. Please click "Report blocked email" to request access. Once confirmed by the owner, you will receive a bypass and be able to create your account (typically 1 hour to 2 days).';
      }).finally(function () {
        sendCodeBtn.disabled = false; sendCodeBtn.textContent = 'Send verification code';
      });
    }

    sendCodeBtn.addEventListener('click', doSendCode);
    resendBtn.addEventListener('click', function () {
      err.textContent = '';
      var email = form.elements['email'].value.trim();
      resendBtn.disabled = true;
      Cloud.sendVerifyCode(email).then(function () {
        startResendTimer();
      }).catch(function (e) {
        err.textContent = (e && e.message) || 'Your school district has blocked email verification. Please click "Report blocked email" to request access. Once confirmed by the owner, you will receive a bypass and be able to create your account (typically 1 hour to 2 days).';
        resendBtn.disabled = false;
      });
    });

    var form = h('form', { class: 'jqrg-auth-form', onsubmit: function (ev) {
      ev.preventDefault();
      err.textContent = '';
      var username = form.elements['username'].value.trim().toLowerCase();
      var email = form.elements['email'].value.trim();
      var displayName = form.elements['display_name'].value.trim();
      var code = (form.elements['email_code'].value || '').trim();
      var pw = form.elements['pw'].value;
      var pw2 = form.elements['pw2'].value;
      if (!/^[a-z0-9]{1,32}$/.test(username)) { err.textContent = 'Username must be 1-32 lowercase letters or numbers.'; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Please enter a valid email address.'; return; }
      if (!emailSkipped) {
        var reason = emailVerifyReason(email);
        if (reason) activateBlockedSkip(reason);
      }
      if (!emailSkipped) {
        if (!emailCodeSent) { err.textContent = 'Please send and enter the email verification code first.'; return; }
        if (!code || code.length !== 6) { err.textContent = 'Please enter the 6-digit verification code.'; return; }
      }
      if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
      if (pw !== pw2) { err.textContent = 'Passwords do not match.'; return; }
      var submit = form.querySelector('.jqrg-auth-submit');
      submit.disabled = true; submit.textContent = 'Creating account\u2026';
      syncPromptInFlight = true;
      var regFields = { username: username, email: email, password: pw, display_name: displayName || username };
      if (!emailSkipped) regFields.email_code = code;
      Cloud.register(regFields).then(function (result) {
        var ack = (result && result.accountKey) ? showJqrgAccountKeyModal(result.accountKey) : Promise.resolve();
        return ack.then(function () {
          onSignedIn();
          maybeOfferLocalSync(function () {
            syncPromptInFlight = false;
            setTab('profile');
          });
        });
      }).catch(function (e) {
        syncPromptInFlight = false;
        var msg = (e && e.message) || 'Sign-up failed.';
        if (msg.indexOf('Verification code is required') !== -1) {
          // Server still requires a code for this address (skip lists drifted).
          // Fall back to the normal code flow instead of leaving the user stuck.
          emailSkipped = false; emailCodeSent = false; forceCodeFlow = true;
          skipInfo.style.display = 'none';
          serverSkipInfo.style.display = 'none';
          blockedInfo.style.display = 'none';
          verifyRow.style.display = 'none';
          sendCodeBtn.style.display = '';
          err.textContent = 'We couldn\u2019t skip verification for this email \u2014 send a code below and enter it to finish signing up.';
        } else {
          err.textContent = msg;
        }
        submit.disabled = false; submit.textContent = 'Create account';
      });
    }});
    form.appendChild(h('div', { class: 'jqrg-gate-intro' }, [
      h('strong', null, 'It\u2019s a normal, free sign-up.'),
      ' Your game saves and progress get stored on your account, so if I ever move the site to a new link your data ',
      h('strong', null, 'comes with you and won\u2019t be lost'),
      '. Anything already saved in this browser stays on this device too \u2014 it gets uploaded to your new account automatically as soon as it\u2019s created.'
    ]));
    form.appendChild(h('div', { style: 'font-size:12px;color:rgba(255,255,255,.55);line-height:1.55;margin-bottom:10px;padding:8px 10px;background:rgba(136,65,214,.1);border-radius:8px;border-left:3px solid #8841d6' }, [
      h('strong', { style: 'color:rgba(255,255,255,.8)' }, 'NOTE:'),
      ' If your school district blocks external emails, click \u201cCan\u2019t receive email?\u201d after entering your email. Your organization will be added to the allow-list so you can still verify.'
    ]));
    form.appendChild(h('label', null, [
      'Username (lowercase, letters + numbers)',
      h('input', { type: 'text', name: 'username', autocomplete: 'username', required: 'required', maxlength: '32', pattern: '[a-z0-9]+', autofocus: 'autofocus' }),
    ]));
    form.appendChild(h('label', null, [
      'Email',
      h('input', { type: 'email', name: 'email', autocomplete: 'email', required: 'required', maxlength: '255', oninput: function () {
        var val = this.value.trim();
        if (emailCodeSent || emailSkipped) {
          emailCodeSent = false;
          emailSkipped = false;
          verifyInfo.style.display = 'none';
          skipInfo.style.display = 'none';
          blockedInfo.style.display = 'none';
          serverSkipInfo.style.display = 'none';
          verifyRow.style.display = 'none';
          forceCodeFlow = false;
          sendCodeBtn.style.display = '';
          cantReceiveMsg.style.display = 'none';
          if (resendInterval) { clearInterval(resendInterval); resendInterval = null; }
        }
        var reason = emailVerifyReason(val);
        if (reason) {
          if (forceCodeFlow) {
            sendCodeBtn.style.display = '';
            cantReceiveBtn.style.display = '';
          } else {
            activateBlockedSkip(reason);
          }
        } else {
          forceCodeFlow = false;
          sendCodeBtn.style.display = '';
          cantReceiveBtn.style.display = val ? '' : 'none';
        }
      } }),
    ]));
    form.appendChild(sendCodeBtn);
    form.appendChild(cantReceiveBtn);
    form.appendChild(cantReceiveMsg);
    form.appendChild(verifyRow);
    form.appendChild(skipInfo);
    form.appendChild(serverSkipInfo);
    form.appendChild(blockedInfo);
    form.appendChild(h('label', null, [
      'Display name (optional)',
      h('input', { type: 'text', name: 'display_name', maxlength: '64' }),
    ]));
    form.appendChild(h('label', null, [
      'Password (6+ characters)',
      h('input', { type: 'password', name: 'pw', autocomplete: 'new-password', required: 'required', minlength: '6' }),
    ]));
    form.appendChild(h('label', null, [
      'Confirm password',
      h('input', { type: 'password', name: 'pw2', autocomplete: 'new-password', required: 'required', minlength: '6' }),
    ]));
    form.appendChild(err);
    form.appendChild(h('button', { type: 'submit', class: 'jqrg-auth-submit' }, 'Create account'));
    form.appendChild(h('div', { class: 'jqrg-auth-hint' }, 'One account signs you in here and on JimmyQrg Chat. Your existing local saves stay on this device and are uploaded to your new account on first sign-in.'));
    return form;
  }

  /** Read-only email row inside the profile pane. Clicking the trailing
   *  button flips `container` into showEmailEditor() and back. Accounts
   *  whose chat record predates the email column have NULL stored, so we
   *  highlight that path with the "missing" variant + an inline hint. */
  function renderEmailSection(container) {
    var user = Cloud.getUser();
    var hasEmail = !!(user && user.email);
    container.innerHTML = '';
    var rowEl = h('div', { class: 'jqrg-email-row' + (hasEmail ? '' : ' missing') });
    rowEl.appendChild(h('div', { class: 'jqrg-email-label' }, 'Email'));
    if (hasEmail) {
      rowEl.appendChild(h('div', { class: 'jqrg-email-value', title: user.email }, user.email));
    } else {
      rowEl.appendChild(h('div', { class: 'jqrg-email-missing' }, 'not set'));
    }
    rowEl.appendChild(h('button', {
      type: 'button',
      class: 'jqrg-email-edit',
      onclick: function () { showEmailEditor(container); },
    }, hasEmail ? 'Edit' : 'Add email'));
    container.appendChild(rowEl);
    if (!hasEmail) {
      container.appendChild(h('div', { class: 'jqrg-email-hint' },
        'Add an email so you can sign in with it next time (and recover this account).'));
    }
  }

  /** Replace `container` with an inline email-edit form. On save we hit
   *  Cloud.updateProfile({ email }), which PATCHes /api/users/profile - that
   *  endpoint validates format + uniqueness and refreshes the cached user. */
  function showEmailEditor(container) {
    var user = Cloud.getUser();
    container.innerHTML = '';
    var form = h('form', { class: 'jqrg-email-form' });
    var input = h('input', {
      type: 'email',
      name: 'email',
      value: (user && user.email) || '',
      placeholder: 'you@example.com',
      autocomplete: 'email',
      maxlength: '255',
      required: 'required',
      autofocus: 'autofocus',
    });
    form.appendChild(h('label', null, ['Email address', input]));
    var err = h('div', { class: 'jqrg-auth-error' });
    form.appendChild(err);
    var cancel = h('button', { type: 'button', class: 'jqrg-btn-ghost', onclick: function () {
      renderEmailSection(container);
    } }, 'Cancel');
    var save = h('button', { type: 'submit', class: 'jqrg-auth-submit' }, 'Save email');
    form.appendChild(h('div', { class: 'jqrg-email-actions' }, [cancel, save]));
    form.onsubmit = function (ev) {
      ev.preventDefault();
      err.textContent = '';
      var email = (input.value || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        err.textContent = 'Please enter a valid email address.';
        return;
      }
      save.disabled = true; cancel.disabled = true;
      save.textContent = 'Saving\u2026';
      Cloud.updateProfile({ email: email }).then(function () {
        renderEmailSection(container);
      }).catch(function (e) {
        err.textContent = (e && e.message) || 'Save failed.';
        save.disabled = false; cancel.disabled = false;
        save.textContent = 'Save email';
      });
    };
    container.appendChild(form);
    setTimeout(function () { try { input.focus(); input.select(); } catch (_) {} }, 0);
  }

  function buildProfileForm() {
    var user = Cloud.getUser();
    var wrap = h('div', { class: 'jqrg-auth-form' });
    var row = h('div', { class: 'jqrg-profile-row' });
    var bigAvatar = h('div', { class: 'jqrg-big-avatar' });
    if (user) renderAvatarImg(bigAvatar, user);
    else bigAvatar.innerHTML = USER_ICON_SVG;
    row.appendChild(bigAvatar);
    var info = h('div', { class: 'jqrg-profile-info' });
    info.appendChild(h('div', { class: 'jqrg-profile-name' }, (user && (user.display_name || user.username)) || 'Signed in'));
    info.appendChild(h('div', { class: 'jqrg-profile-user' }, '@' + (user && user.username || '')));
    row.appendChild(info);
    wrap.appendChild(row);

    // Email management. Re-rendered in place when the user toggles between
    // the read-only view, the editor, and after a successful save - so we
    // keep a section element and let buildEmailSection() repaint it.
    var emailSection = h('div', { class: 'jqrg-email-section' });
    renderEmailSection(emailSection);
    wrap.appendChild(emailSection);

    var syncStatus = h('div', { class: 'jqrg-sync-status' }, 'Game saves are syncing to the cloud');
    wrap.appendChild(syncStatus);

    var actions = h('div', { class: 'jqrg-profile-actions' });

    actions.appendChild(h('button', {
      class: 'jqrg-profile-action',
      type: 'button',
      onclick: function () { showJqrgViewKeyModal(); },
    }, [actionIcon(ICON_KEY_SVG), 'View account key']));

    actions.appendChild(h('button', {
      class: 'jqrg-profile-action',
      type: 'button',
      onclick: function () { doExport(syncStatus); },
    }, [actionIcon(ICON_EXPORT_SVG), 'Export data']));

    actions.appendChild(h('button', {
      class: 'jqrg-profile-action',
      type: 'button',
      onclick: function () { doImport(syncStatus); },
    }, [actionIcon(ICON_IMPORT_SVG), 'Import data']));

    actions.appendChild(h('button', {
      class: 'jqrg-profile-action danger',
      type: 'button',
      onclick: function () { doDeleteAll(); },
    }, [actionIcon(ICON_TRASH_SVG), 'Delete all data']));

    actions.appendChild(h('button', {
      class: 'jqrg-profile-action danger',
      type: 'button',
      onclick: function () {
        Cloud.logout().then(function () {
          onSignedOut();
        });
      },
    }, [actionIcon(ICON_SIGNOUT_SVG), 'Sign out']));

    wrap.appendChild(actions);
    return wrap;
  }

  function doExport(statusEl) {
    if (!Cloud.isLoggedIn()) return;
    if (statusEl) statusEl.textContent = 'Preparing export…';
    Cloud.forceSync().catch(function () {}).then(function () {
      return Cloud.exportAll();
    }).then(function (snapshot) {
      var json = JSON.stringify(snapshot, null, 2);
      var user = Cloud.getUser();
      var name = (user && user.username ? user.username : 'jqrg') + '-saves-' + new Date().toISOString().slice(0, 10) + '.json';
      downloadBlob(name, 'application/json', json);
      if (statusEl) {
        statusEl.textContent = 'Exported ' + (snapshot.items ? snapshot.items.length : 0) + ' saves';
        statusEl.classList.add('active');
        setTimeout(function () { statusEl.classList.remove('active'); statusEl.textContent = 'Game saves are syncing to the cloud'; }, 2500);
      }
    }).catch(function (err) {
      if (statusEl) statusEl.textContent = 'Export failed: ' + ((err && err.message) || 'unknown');
    });
  }

  function doImport(statusEl) {
    if (!Cloud.isLoggedIn()) return;
    pickFile('application/json,.json').then(function (file) {
      if (!file) return;
      if (statusEl) statusEl.textContent = 'Reading ' + file.name + '…';
      return file.text().then(function (text) {
        var data;
        try { data = JSON.parse(text); } catch (_) { throw new Error('File is not valid JSON.'); }
        return Cloud.importAll(data).then(function (result) {
          if (statusEl) {
            statusEl.textContent = 'Imported ' + (result.accepted || 0) + ' saves' + (result.rejected ? ' (' + result.rejected + ' rejected)' : '');
            statusEl.classList.add('active');
            setTimeout(function () { statusEl.classList.remove('active'); statusEl.textContent = 'Game saves are syncing to the cloud'; }, 3000);
          }
          return Cloud.forceSync().catch(function () {});
        });
      });
    }).catch(function (err) {
      if (statusEl) statusEl.textContent = 'Import failed: ' + ((err && err.message) || 'unknown');
    });
  }

  function doDeleteAll() {
    var previousTab = currentTab;
    var body = modalEl && modalEl.querySelector('.jqrg-auth-body');
    if (!body) return;
    body.innerHTML = '';
    var wrap = h('div', { class: 'jqrg-auth-form' });
    wrap.appendChild(h('div', { class: 'jqrg-confirm-msg' }, [
      'This will permanently remove ',
      h('span', { class: 'jqrg-confirm-danger' }, 'all of your saved game data'),
      ' from the cloud and from this browser. Progress cannot be recovered after confirmation.',
    ]));
    wrap.appendChild(h('div', { class: 'jqrg-confirm-note' }, 'Your account itself will not be deleted — only the saves.'));

    var cancel = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Cancel');
    var proceed = h('button', { type: 'button', class: 'jqrg-btn-danger' }, 'I understand, continue');

    var actions = h('div', { class: 'jqrg-confirm-actions' }, [cancel, proceed]);
    wrap.appendChild(actions);
    body.appendChild(wrap);

    cancel.onclick = function () { setTab(Cloud.isLoggedIn() ? 'profile' : previousTab); };

    proceed.onclick = function () {
      body.innerHTML = '';
      var step2 = h('div', { class: 'jqrg-auth-form' });
      step2.appendChild(h('div', { class: 'jqrg-confirm-msg' }, [
        'Type ',
        h('span', { class: 'jqrg-confirm-danger' }, 'DELETE'),
        ' (all caps) to confirm. This cannot be undone.',
      ]));
      var input = h('input', {
        type: 'text',
        class: 'jqrg-confirm-input',
        maxlength: '6',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        autocapitalize: 'characters',
        autofocus: 'autofocus',
        placeholder: 'DELETE',
      });
      step2.appendChild(input);
      var err = h('div', { class: 'jqrg-auth-error' });
      step2.appendChild(err);
      var cancel2 = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Cancel');
      var finalBtn = h('button', { type: 'button', class: 'jqrg-btn-danger', disabled: 'disabled' }, 'Delete everything');
      step2.appendChild(h('div', { class: 'jqrg-confirm-actions' }, [cancel2, finalBtn]));
      body.appendChild(step2);

      input.addEventListener('input', function () {
        var v = (input.value || '').trim().toUpperCase();
        input.value = v;
        finalBtn.disabled = v !== 'DELETE';
      });

      cancel2.onclick = function () { setTab(Cloud.isLoggedIn() ? 'profile' : previousTab); };

      finalBtn.onclick = function () {
        if ((input.value || '').trim().toUpperCase() !== 'DELETE') return;
        finalBtn.disabled = true; cancel2.disabled = true; input.disabled = true;
        finalBtn.textContent = 'Deleting…';
        Cloud.deleteAll().then(function () {
          body.innerHTML = '';
          var done = h('div', { class: 'jqrg-auth-form' }, [
            h('div', { class: 'jqrg-confirm-msg' }, 'All saves deleted.'),
            h('div', { class: 'jqrg-auth-hint' }, 'Your local storage has been wiped and the server now shows zero saved games for this account.'),
            h('button', { type: 'button', class: 'jqrg-btn-ghost', onclick: function () { setTab('profile'); } }, 'Back to account'),
          ]);
          body.appendChild(done);
        }).catch(function (e) {
          err.textContent = 'Delete failed: ' + ((e && e.message) || 'unknown');
          finalBtn.disabled = false; cancel2.disabled = false; input.disabled = false;
          finalBtn.textContent = 'Delete everything';
        });
      };
    };
  }

  // Track sync-prompt state for this session so we don't re-prompt mid-flow or nest prompts.
  var syncPromptInFlight = false;

  /** Show the "you have local data not synced" prompt inside the open modal's content area.
   *  `onDone(result)` runs after the user has resolved the prompt. Possible results:
   *    - 'pushed' / 'overwritten' — sync completed, summary contains push details
   *    - 'erased'                — user wiped local data, summary contains counts
   *    - 'skipped'               — user picked "Not now"; migration key is left
   *      untouched so the next openModal() will re-prompt. This is intentional
   *      per UX spec — "Not Now" must keep nagging the user every time they
   *      click on the account icon until they pick a real answer.
   *    - 'cancelled'             — user backed out of the overwrite warning.
   *  Must be called with the modal already open. */
  function showSyncPrompt(onDone) {
    if (!modalEl) { if (onDone) onDone('no-modal'); return; }
    var tabsEl = modalEl.querySelector('.jqrg-auth-tabs');
    var content = modalEl.querySelector('.jqrg-auth-content');
    var titleEl = modalEl.querySelector('.jqrg-auth-title');
    if (!content) { if (onDone) onDone('no-content'); return; }
    if (tabsEl) tabsEl.style.display = 'none';
    if (titleEl) titleEl.textContent = 'Sync local data?';
    content.innerHTML = '';

    syncPromptInFlight = true;

    var wrap = h('div', { class: 'jqrg-auth-form' });
    wrap.appendChild(h('div', { class: 'jqrg-confirm-msg' }, [
      'We found ',
      h('span', { class: 'jqrg-confirm-danger' }, 'game save data on this device'),
      ' that hasn\'t been uploaded to your account yet.',
    ]));
    wrap.appendChild(h('div', { class: 'jqrg-confirm-note' }, 'Choose what to do with the local data on this device.'));
    var errBox = h('div', { class: 'jqrg-auth-error' });
    wrap.appendChild(errBox);
    // Layout convention: destructive on the left (Erase), neutral in the middle
    // (Not Now), primary action on the right (Sync). Keeping the dangerous
    // option in the leftmost slot reduces fat-finger taps on Sync that overshoot
    // into Erase, which is the worst possible misclick here.
    var erase = h('button', { type: 'button', class: 'jqrg-btn-danger' }, 'Erase');
    var notNow = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Not Now');
    var merge = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Merge');
    var sync = h('button', { type: 'button', class: 'jqrg-auth-submit' }, 'Sync');
    wrap.appendChild(h('div', { class: 'jqrg-confirm-actions' }, [erase, notNow, merge, sync]));
    content.appendChild(wrap);

    var finish = function (result, summary) {
      syncPromptInFlight = false;
      if (onDone) onDone(result, summary);
    };

    notNow.onclick = function () {
      // Intentionally NOT calling Cloud.skipLocalMigration() — leaving the
      // migration record absent means hasUnsyncedLocalData() stays truthy, so
      // the next openModal() (i.e. the user clicking on their account icon
      // again) will re-trigger maybeOfferLocalSync() and show this prompt
      // again. The previous behaviour permanently dismissed the prompt for
      // this device, which buried unsynced saves where the user could never
      // see them.
      finish('skipped');
    };

    erase.onclick = function () { showEraseConfirm(finish); };

    sync.onclick = function () {
      erase.disabled = true; notNow.disabled = true; sync.disabled = true;
      sync.textContent = 'Checking your account…';
      errBox.textContent = '';
      Cloud.isAccountEmpty().then(function (empty) {
        if (empty) {
          sync.textContent = 'Uploading…';
          return Cloud.pushAllLocal().then(function (summary) { finish('pushed', summary); });
        }
        showOverwriteWarning(finish);
      }).catch(function (err) {
        errBox.textContent = (err && err.message) || 'Sync failed.';
        erase.disabled = false; notNow.disabled = false; sync.disabled = false;
        sync.textContent = 'Sync';
      });
    };

    merge.onclick = function () {
      erase.disabled = true; notNow.disabled = true; merge.disabled = true; sync.disabled = true;
      merge.textContent = 'Merging…';
      errBox.textContent = '';
      Cloud.isAccountEmpty().then(function (empty) {
        if (empty) {
          merge.textContent = 'Merging…';
          return Cloud.mergeLocalToAccount().then(function (summary) { finish('merged', summary); });
        }
        showMergeWarning(finish);
      }).catch(function (err) {
        errBox.textContent = (err && err.message) || 'Merge failed.';
        erase.disabled = false; notNow.disabled = false; merge.disabled = false; sync.disabled = false;
        merge.textContent = 'Merge';
      });
    };
  }

  function showMergeWarning(onDone) {
    if (!modalEl) { if (onDone) onDone('no-modal'); return; }
    var content = modalEl.querySelector('.jqrg-auth-content');
    var titleEl = modalEl.querySelector('.jqrg-auth-title');
    if (!content) { if (onDone) onDone('no-content'); return; }
    if (titleEl) titleEl.textContent = 'Merge data?';
    content.innerHTML = '';

    var wrap = h('div', { class: 'jqrg-auth-form' });
    wrap.appendChild(h('div', { class: 'jqrg-confirm-msg' }, [
      'Your account already has saved data. The merge will ',
      h('span', { class: 'jqrg-confirm-danger' }, 'only upload data for games that have local data'),
      '. Games with only account data will be preserved.',
    ]));
    wrap.appendChild(h('div', { class: 'jqrg-confirm-note' }, 'Games without local data will not be affected.'));
    var errBox = h('div', { class: 'jqrg-auth-error' });
    wrap.appendChild(errBox);
    var cancel = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Cancel');
    var proceed = h('button', { type: 'button', class: 'jqrg-btn-danger' }, 'Merge');
    wrap.appendChild(h('div', { class: 'jqrg-confirm-actions' }, [cancel, proceed]));
    content.appendChild(wrap);

    cancel.onclick = function () { if (onDone) onDone('cancelled'); };

    proceed.onclick = function () {
      cancel.disabled = true; proceed.disabled = true;
      proceed.textContent = 'Merging…';
      errBox.textContent = '';
      Cloud.mergeLocalToAccount().then(function (summary) {
        if (onDone) onDone('merged', summary);
      }).catch(function (err) {
        errBox.textContent = (err && err.message) || 'Merge failed.';
        cancel.disabled = false; proceed.disabled = false;
        proceed.textContent = 'Merge';
      });
    };
  }

  /** Confirmation pane shown when the user clicks "Erase" on the sync prompt.
   *  Replaces the prompt content with a single yes/no confirmation. Cancel
   *  re-opens the original prompt; Erase wipes local syncable data via the
   *  cloud module and resolves the outer prompt with result === 'erased'.
   *
   *  We deliberately keep this confirmation lightweight (a single dialog,
   *  no DELETE-typing dance like deleteAll uses) because the action only
   *  affects the current device — the server-side account is untouched, so
   *  the worst-case is the user having to re-download their saves the next
   *  time they open a game, which the cloud module handles automatically. */
  function showEraseConfirm(finish) {
    if (!modalEl) { finish('no-modal'); return; }
    var content = modalEl.querySelector('.jqrg-auth-content');
    var titleEl = modalEl.querySelector('.jqrg-auth-title');
    if (!content) { finish('no-content'); return; }
    if (titleEl) titleEl.textContent = 'Erase local data?';
    content.innerHTML = '';

    var wrap = h('div', { class: 'jqrg-auth-form' });
    wrap.appendChild(h('div', { class: 'jqrg-confirm-msg' }, [
      'This will permanently remove ',
      h('span', { class: 'jqrg-confirm-danger' }, 'every game save stored on this device'),
      '. Your account on the server is not touched.',
    ]));
    wrap.appendChild(h('div', { class: 'jqrg-confirm-note' }, 'When you launch a game next, your account\'s saved progress will be downloaded fresh.'));
    var errBox = h('div', { class: 'jqrg-auth-error' });
    wrap.appendChild(errBox);

    var cancel = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Cancel');
    var proceed = h('button', { type: 'button', class: 'jqrg-btn-danger' }, 'Erase local data');
    wrap.appendChild(h('div', { class: 'jqrg-confirm-actions' }, [cancel, proceed]));
    content.appendChild(wrap);

    cancel.onclick = function () {
      showSyncPrompt(function (result, summary) { finish(result, summary); });
    };

    proceed.onclick = function () {
      cancel.disabled = true; proceed.disabled = true;
      proceed.textContent = 'Erasing…';
      errBox.textContent = '';
      Promise.resolve(Cloud.wipeLocalSyncable()).then(function (summary) {
        finish('erased', summary);
      }).catch(function (err) {
        errBox.textContent = (err && err.message) || 'Erase failed.';
        cancel.disabled = false; proceed.disabled = false;
        proceed.textContent = 'Erase local data';
      });
    };
  }

  /** Second-step confirmation shown when the server already has saved data. Replaces the
   *  content pane of the same modal. `onDone('overwritten'|'cancelled')` fires when the user
   *  completes or cancels. */
  function showOverwriteWarning(onDone) {
    if (!modalEl) { if (onDone) onDone('no-modal'); return; }
    var content = modalEl.querySelector('.jqrg-auth-content');
    var titleEl = modalEl.querySelector('.jqrg-auth-title');
    if (!content) { if (onDone) onDone('no-content'); return; }
    if (titleEl) titleEl.textContent = 'Overwrite account data?';
    content.innerHTML = '';

    var wrap = h('div', { class: 'jqrg-auth-form' });
    wrap.appendChild(h('div', { class: 'jqrg-confirm-msg' }, [
      'Your account already has saved data. Continuing will ',
      h('span', { class: 'jqrg-confirm-danger' }, 'overwrite everything currently stored on the account'),
      ' with the data from this device.',
    ]));
    wrap.appendChild(h('div', { class: 'jqrg-confirm-note' }, 'This cannot be undone. Export your account data first from the account page if you want to keep it.'));
    var errBox = h('div', { class: 'jqrg-auth-error' });
    wrap.appendChild(errBox);
    var cancel = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Cancel');
    var proceed = h('button', { type: 'button', class: 'jqrg-btn-danger' }, 'Rewrite');
    wrap.appendChild(h('div', { class: 'jqrg-confirm-actions' }, [cancel, proceed]));
    content.appendChild(wrap);

    cancel.onclick = function () { if (onDone) onDone('cancelled'); };

    proceed.onclick = function () {
      cancel.disabled = true; proceed.disabled = true;
      proceed.textContent = 'Uploading…';
      errBox.textContent = '';
      Cloud.pushAllLocal().then(function (summary) {
        if (onDone) onDone('overwritten', summary);
      }).catch(function (err) {
        errBox.textContent = (err && err.message) || 'Upload failed.';
        cancel.disabled = false; proceed.disabled = false;
        proceed.textContent = 'Rewrite';
      });
    };
  }

  function showMergeWarning(onDone) {
    if (!modalEl) { if (onDone) onDone('no-modal'); return; }
    var content = modalEl.querySelector('.jqrg-auth-content');
    var titleEl = modalEl.querySelector('.jqrg-auth-title');
    if (!content) { if (onDone) onDone('no-content'); return; }
    if (titleEl) titleEl.textContent = 'Merge data?';
    content.innerHTML = '';

    var wrap = h('div', { class: 'jqrg-auth-form' });
    wrap.appendChild(h('div', { class: 'jqrg-confirm-msg' }, [
      'Your account already has saved data. The merge will ',
      h('span', { class: 'jqrg-confirm-danger' }, 'only upload data for games that have local data'),
      '. Games with only account data will be preserved.',
    ]));
    wrap.appendChild(h('div', { class: 'jqrg-confirm-note' }, 'Games without local data will not be affected.'));
    var errBox = h('div', { class: 'jqrg-auth-error' });
    wrap.appendChild(errBox);
    var cancel = h('button', { type: 'button', class: 'jqrg-btn-ghost' }, 'Cancel');
    var proceed = h('button', { type: 'button', class: 'jqrg-btn-danger' }, 'Merge');
    wrap.appendChild(h('div', { class: 'jqrg-confirm-actions' }, [cancel, proceed]));
    content.appendChild(wrap);

    cancel.onclick = function () { if (onDone) onDone('cancelled'); };

    proceed.onclick = function () {
      cancel.disabled = true; proceed.disabled = true;
      proceed.textContent = 'Merging…';
      errBox.textContent = '';
      Cloud.mergeLocalToAccount().then(function (summary) {
        if (onDone) onDone('merged', summary);
      }).catch(function (err) {
        errBox.textContent = (err && err.message) || 'Merge failed.';
        cancel.disabled = false; proceed.disabled = false;
        proceed.textContent = 'Merge';
      });
    };
  }

  /** Entry point: check whether the signed-in user has unsynced local data and, if so, open
   *  the sync prompt. When finished it restores the profile view. Safe to call whether or
   *  not a modal is already visible. `afterFn` is invoked after the prompt resolves (or
   *  immediately if no prompt is shown). */
  function maybeOfferLocalSync(afterFn) {
    var done = function () { if (afterFn) try { afterFn(); } catch (_) {} };
    if (!Cloud.isLoggedIn()) { done(); return; }
    if (syncPromptInFlight) { done(); return; }
    Cloud.hasUnsyncedLocalData().then(function (has) {
      if (!has) { done(); return; }
      var openedHere = false;
      if (!modalEl) {
        openModal({ skipSyncCheck: true });
        openedHere = true;
      }
      // Defer to the next tick so the modal DOM is present.
      setTimeout(function () {
        showSyncPrompt(function () {
          // After the user is done with the prompt, show the profile view. If we opened
          // the modal ourselves purely for the prompt, leave it open so the user can
          // see the result of their action — they can dismiss with the close button.
          setTab('profile');
          done();
        });
      }, openedHere ? 50 : 0);
    }).catch(function () { done(); });
  }

  function openModal(opts) {
    opts = opts || {};
    var wantRequired = !!opts.required;
    if (modalEl) {
      if (wantRequired) modalRequired = true;
      syncModalRequired();
      return;
    }
    modalRequired = wantRequired;
    injectStyles();
    var overlay = h('div', { class: 'jqrg-auth-overlay', onclick: function (e) { if (e.target === overlay) closeModal(); } });
    var modal = h('div', { class: 'jqrg-auth-modal' });
    var head = h('div', { class: 'jqrg-auth-head' });
    head.appendChild(h('div', { class: 'jqrg-auth-title' }, Cloud.isLoggedIn() ? 'Your account' : (wantRequired ? 'Sign in to continue' : 'Sign in')));
    var closeBtn = h('button', { class: 'jqrg-auth-close', type: 'button', 'aria-label': 'Close', onclick: function () { closeModal(); } }, '\u00D7');
    if (wantRequired) closeBtn.setAttribute('disabled', 'disabled');
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = h('div', { class: 'jqrg-auth-body' });
    var tabs = h('div', { class: 'jqrg-auth-tabs' });
    tabs.appendChild(h('button', { type: 'button', class: 'jqrg-auth-tab active', 'data-tab': 'login', onclick: function () { setTab('login'); } }, 'Sign in'));
    tabs.appendChild(h('button', { type: 'button', class: 'jqrg-auth-tab', 'data-tab': 'signup', onclick: function () { setTab('signup'); } }, 'Sign up'));
    body.appendChild(tabs);
    var content = h('div', { class: 'jqrg-auth-content' });
    body.appendChild(content);
    modal.appendChild(body);
    // Now populate the content area via setTab (which uses .jqrg-auth-content).
    // We need the DOM structure in place first.
    overlay.appendChild(modal);
    modalEl = overlay;
    document.body.appendChild(overlay);
    setTab(Cloud.isLoggedIn() ? 'profile' : currentTab);
    requestAnimationFrame(function () { overlay.classList.add('open'); });
    syncModalRequired();
    document.addEventListener('keydown', escHandler);
    // If the user is already signed in and has local data that hasn't been pushed yet,
    // offer to sync it the first time they open the account modal this session.
    if (Cloud.isLoggedIn() && !opts.skipSyncCheck) {
      setTimeout(function () { maybeOfferLocalSync(function () { setTab('profile'); }); }, 50);
    }
  }

  function syncModalRequired() {
    if (!modalEl) return;
    modalEl.classList.toggle('required', modalRequired);
    var close = modalEl.querySelector('.jqrg-auth-close');
    if (close) {
      if (modalRequired) close.setAttribute('disabled', 'disabled');
      else close.removeAttribute('disabled');
    }
  }

  function escHandler(e) {
    if (e.key !== 'Escape') return;
    if (modalRequired) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    closeModal();
  }

  function onSignedIn() {
    // Unblock the page once signed in.
    if (modalRequired) {
      modalRequired = false;
      syncModalRequired();
    }
  }
  function onSignedOut() {
    if (shouldGate() && !Cloud.isLoggedIn()) {
      setTab('login');
      modalRequired = true;
      syncModalRequired();
      if (!modalEl) openModal({ required: true });
    } else {
      setTab('login');
    }
  }

  Cloud.onAuthChange(function () {
    refreshButton();
    if (modalEl) {
      var head = modalEl.querySelector('.jqrg-auth-title');
      if (head) head.textContent = Cloud.isLoggedIn() ? 'Your account' : (modalRequired ? 'Sign in to continue' : 'Sign in');
      // Don't auto-navigate if a sync prompt is (about to be) shown — the caller handles it.
      if (!syncPromptInFlight) {
        setTab(Cloud.isLoggedIn() ? 'profile' : currentTab);
      }
    }
  });

  function maybeGate() {
    if (!shouldGate()) return;
    if (Cloud.isLoggedIn()) return;
    setTimeout(function () {
      if (Cloud.isLoggedIn()) return;
      // If on a sub-page (games/apps/unblocks/contacts hash or a non-index path),
      // redirect to the home page first, then show the required sign-in modal.
      if (isSubPage()) {
        location.hash = '#h';
      }
      if (isOffHomePath()) {
        location.href = '/#h';
        return;
      }
      openModal({ required: true });
    }, 250);
  }

  ready(function () {
    injectStyles();
    ensureTopBarButton();
    // In case the top bar renders later (e.g. if the index.html rewrites it),
    // poll briefly rather than using a MutationObserver on the whole body (which
    // fires on every DOM mutation and created feedback loops on heavy pages).
    if (!topBarBtn) {
      var attempts = 0;
      var retryTimer = setInterval(function () {
        attempts++;
        ensureTopBarButton();
        if (topBarBtn || attempts > 20) clearInterval(retryTimer);
      }, 500);
    }

    // Intercept the page's navigate() so non-home tabs require sign-in.
    if (typeof window.navigate === 'function') {
      var _origNavigate = window.navigate;
      window.navigate = function (page) {
        if (page !== 'home' && !Cloud.isLoggedIn() && shouldGate()) {
          openModal({ required: true });
          return;
        }
        return _origNavigate.apply(this, arguments);
      };
    }
    // Also intercept openGame so launching games requires sign-in.
    if (typeof window.openGame === 'function') {
      var _origOpenGame = window.openGame;
      window.openGame = function () {
        if (!Cloud.isLoggedIn() && shouldGate()) {
          openModal({ required: true });
          return;
        }
        return _origOpenGame.apply(this, arguments);
      };
    }
    // Same gate for the direct iframe-loader path used by apps/unblocks tiles.
    if (typeof window._lP === 'function') {
      var _origLp = window._lP;
      window._lP = function () {
        if (!Cloud.isLoggedIn() && shouldGate()) {
          openModal({ required: true });
          return;
        }
        return _origLp.apply(this, arguments);
      };
    }
    // Intercept proxyNavigate (unblocks URL bar).
    if (typeof window.proxyNavigate === 'function') {
      var _origProxyNavigate = window.proxyNavigate;
      window.proxyNavigate = function () {
        if (!Cloud.isLoggedIn() && shouldGate()) {
          openModal({ required: true });
          return;
        }
        return _origProxyNavigate.apply(this, arguments);
      };
    }

    // Expose a way for page code to open the dialog programmatically.
    window.openJqrgAuth = openModal;
    window.closeJqrgAuth = function () { closeModal(true); };
    window.JqrgAuthUI = {
      openModal: openModal,
      closeModal: function () { closeModal(true); },
      export: function () { return Cloud.exportAll(); },
      import: function (data) { return Cloud.importAll(data); },
      deleteAll: function () { return Cloud.deleteAll(); },
    };

    maybeGate();
  });
})();
