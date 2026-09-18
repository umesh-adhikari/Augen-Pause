// Classic (non-module) script that runs before the ES modules are loaded.
// Buffers `navigate` pushes that main may send while the modules are still being fetched,
// so an "open dashboard on tab X" request is never lost. dashboard.js takes over afterwards.
(function () {
  'use strict';
  var api = window.augenpause;
  if (!api || typeof api.onNavigate !== 'function') return;
  var buffer = { tab: null, unsubscribe: null };
  buffer.unsubscribe = api.onNavigate(function (tab) {
    buffer.tab = tab;
  });
  Object.defineProperty(window, '__augenpauseBoot', { value: buffer, configurable: true });
})();
