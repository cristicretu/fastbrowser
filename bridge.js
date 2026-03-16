(function () {
  var errors = [];
  var perfObserver = null;
  var perfStart = 0;
  var perfEntries = {};

  // --- Error capture ---

  var origConsoleError = console.error;
  console.error = function () {
    var args = Array.prototype.slice.call(arguments);
    var message;
    try {
      message = args
        .map(function (a) {
          return typeof a === 'string' ? a : JSON.stringify(a);
        })
        .join(' ');
    } catch (e) {
      message = String(args[0]);
    }
    errors.push({ type: 'console.error', message: message, timestamp: Date.now() });
    return origConsoleError.apply(console, arguments);
  };

  window.addEventListener('error', function (e) {
    errors.push({
      type: 'uncaught',
      message: e.message || String(e),
      timestamp: Date.now(),
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var message;
    try {
      message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason);
    } catch (_) {
      message = String(reason);
    }
    errors.push({
      type: 'unhandledrejection',
      message: message,
      timestamp: Date.now(),
    });
  });

  // --- React render counting ---

  function hookReactRenders() {
    var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && typeof hook.onCommitFiberRoot === 'function' && !hook.__fb_patched) {
      var orig = hook.onCommitFiberRoot;
      hook.onCommitFiberRoot = function () {
        if (window.__fb) {
          window.__fb._renderCount = (window.__fb._renderCount || 0) + 1;
        }
        return orig.apply(this, arguments);
      };
      hook.__fb_patched = true;
    }
  }

  // --- API ---

  window.__fb = {
    _renderCount: 0,

    startPerf: function () {
      // Reset
      perfEntries = {};
      window.__fb._renderCount = 0;

      if (perfObserver) {
        if (Array.isArray(perfObserver)) {
          for (var o = 0; o < perfObserver.length; o++) {
            try { perfObserver[o].disconnect(); } catch (_) {}
          }
        } else {
          try { perfObserver.disconnect(); } catch (_) {}
        }
      }

      perfStart = performance.now();

      var types = ['longtask', 'layout-shift', 'paint', 'largest-contentful-paint'];

      try {
        perfObserver = new PerformanceObserver(function (list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var type = entry.entryType;
            if (!perfEntries[type]) perfEntries[type] = [];
            perfEntries[type].push(entry);
          }
        });
        perfObserver.observe({ entryTypes: types });
      } catch (e) {
        // Some entry types may not be supported; try them individually
        perfObserver = null;
        var observers = [];
        for (var t = 0; t < types.length; t++) {
          try {
            var obs = new PerformanceObserver(function (list) {
              var entries = list.getEntries();
              for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var type = entry.entryType;
                if (!perfEntries[type]) perfEntries[type] = [];
                perfEntries[type].push(entry);
              }
            });
            obs.observe({ entryTypes: [types[t]] });
            observers.push(obs);
          } catch (_) {}
        }
        // Store array so stopPerf can disconnect all
        perfObserver = observers;
      }
    },

    stopPerf: function () {
      if (perfObserver) {
        if (Array.isArray(perfObserver)) {
          for (var o = 0; o < perfObserver.length; o++) {
            try { perfObserver[o].disconnect(); } catch (_) {}
          }
        } else {
          try { perfObserver.disconnect(); } catch (_) {}
        }
        perfObserver = null;
      }

      var totalMs = performance.now() - perfStart;
      var marks = [];

      var typeKeys = Object.keys(perfEntries);
      for (var t = 0; t < typeKeys.length; t++) {
        var type = typeKeys[t];
        var arr = perfEntries[type];
        for (var i = 0; i < arr.length; i++) {
          var e = arr[i];
          var mark = { type: type, startTime: e.startTime, duration: e.duration };
          if (type === 'layout-shift' && e.value !== undefined) mark.value = e.value;
          if (type === 'largest-contentful-paint') {
            if (e.size !== undefined) mark.size = e.size;
            if (e.element) mark.element = e.element.tagName;
          }
          if (e.name) mark.name = e.name;
          marks.push(mark);
        }
      }

      var memoryMB = null;
      try {
        if (performance.memory) {
          memoryMB = Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10;
        }
      } catch (_) {}

      return {
        totalMs: totalMs,
        marks: marks,
        memoryMB: memoryMB,
        domNodes: document.querySelectorAll('*').length,
        renderCount: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ? (window.__fb._renderCount || 0) : null,
      };
    },

    clearErrors: function () {
      errors.length = 0;
    },

    getErrors: function () {
      return errors.slice();
    },

    getState: function () {
      var ls = {};
      var ss = {};
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var key = localStorage.key(i);
          ls[key] = localStorage.getItem(key);
        }
      } catch (_) {}
      try {
        for (var j = 0; j < sessionStorage.length; j++) {
          var skey = sessionStorage.key(j);
          ss[skey] = sessionStorage.getItem(skey);
        }
      } catch (_) {}

      var appState = null;
      try {
        if (typeof window.__FB_APP_STATE__ === 'function') {
          appState = window.__FB_APP_STATE__();
        }
      } catch (_) {}

      return {
        localStorage: ls,
        sessionStorage: ss,
        url: location.href,
        appState: appState,
      };
    },

    restoreState: function (state) {
      if (!state) return;
      try {
        localStorage.clear();
        if (state.localStorage) {
          var lsKeys = Object.keys(state.localStorage);
          for (var i = 0; i < lsKeys.length; i++) {
            localStorage.setItem(lsKeys[i], state.localStorage[lsKeys[i]]);
          }
        }
      } catch (_) {}
      try {
        sessionStorage.clear();
        if (state.sessionStorage) {
          var ssKeys = Object.keys(state.sessionStorage);
          for (var j = 0; j < ssKeys.length; j++) {
            sessionStorage.setItem(ssKeys[j], state.sessionStorage[ssKeys[j]]);
          }
        }
      } catch (_) {}

      if (typeof window.__FB_RESTORE_STATE__ === 'function' && state.appState != null) {
        try {
          window.__FB_RESTORE_STATE__(state.appState);
        } catch (_) {}
      }
    },

    getElementInfo: function (selector) {
      var notFound = { exists: false, visible: false, text: null, rect: null, tag: null, attributes: null };
      var el;
      try {
        el = document.querySelector(selector);
      } catch (_) {
        return notFound;
      }
      if (!el) return notFound;

      var rect = el.getBoundingClientRect();
      var style = getComputedStyle(el);
      var visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;

      var attrs = {};
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        attrs[a.name] = a.value;
      }

      return {
        exists: true,
        visible: visible,
        text: (el.textContent || '').trim().substring(0, 200),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        tag: el.tagName.toLowerCase(),
        attributes: attrs,
      };
    },

    ready: false,
  };

  hookReactRenders();

  window.__fb.ready = true;
})();
