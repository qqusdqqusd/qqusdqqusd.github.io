(function () {
  'use strict';
  if (window.__jqrgGateLoaded) return;
  window.__jqrgGateLoaded = true;

  var SESSION_KEY = '__jqrg_gate_ok';
  var VERIFY_DELAY = 2000;

  function isProxy() {
    var HOSTS = ['perfectnip.github.io', 'jimmyq-r-g.github.io', 'localhost', '127.0.0.1'];
    function ok(h) { for (var i = 0; i < HOSTS.length; i++) { if (h === HOSTS[i]) return true; } return false; }
    try { if (!ok(location.hostname)) return true; } catch (_) { return true; }
    try { var a = document.createElement('a'); a.href = '/'; if (a.hostname && !ok(a.hostname)) return true; } catch (_) {}
    try { var h = (new Function('return location'))().hostname; if (h && !ok(h)) return true; } catch (_) {}
    try {
      var g = (0, eval)('this');
      var names = ['__uv$config', '__uv', '$scramjet', '$scramjet$wrap', '$scramjet$prop', '__dynamic$config', '$aero', '__meteor'];
      for (var i = 0; i < names.length; i++) { if (g[names[i]] !== undefined) return true; }
    } catch (_) {}
    return false;
  }

  function revealSite() {
    document.documentElement.classList.add('gate-pass');
  }

  if (isProxy()) return;
  if (window.__JqrgBotScore >= 5) return;

  window.__jqrgGatePassed = true;

  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    revealSite();
  } else {
    sessionStorage.setItem(SESSION_KEY, '1');
    setTimeout(revealSite, VERIFY_DELAY);
  }
})();
