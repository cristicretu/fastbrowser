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

  // --- Console capture (log + warn) ---

  var consoleLogs = [];
  var CONSOLE_LOG_CAP = 200;

  function formatArgs(args) {
    try {
      return args
        .map(function (a) {
          return typeof a === 'string' ? a : JSON.stringify(a);
        })
        .join(' ');
    } catch (e) {
      return String(args[0]);
    }
  }

  var origLog = console.log;
  console.log = function () {
    var args = Array.prototype.slice.call(arguments);
    consoleLogs.push({ level: 'log', message: formatArgs(args), timestamp: Date.now() });
    if (consoleLogs.length > CONSOLE_LOG_CAP) consoleLogs.shift();
    return origLog.apply(console, arguments);
  };

  var origWarn = console.warn;
  console.warn = function () {
    var args = Array.prototype.slice.call(arguments);
    consoleLogs.push({ level: 'warn', message: formatArgs(args), timestamp: Date.now() });
    if (consoleLogs.length > CONSOLE_LOG_CAP) consoleLogs.shift();
    return origWarn.apply(console, arguments);
  };

  // --- Network logging ---

  var networkLog = [];
  var NETWORK_LOG_CAP = 200;
  var networkLogging = false;
  var origFetch = null;
  var origXhrOpen = null;
  var origXhrSend = null;

  function startNetworkLog() {
    if (networkLogging) return;
    networkLogging = true;

    // Patch fetch
    origFetch = window.fetch;
    window.fetch = function (input, init) {
      var method = (init && init.method) ? init.method.toUpperCase() : 'GET';
      var url;
      if (typeof input === 'string') {
        url = input;
      } else if (input && input.url) {
        url = input.url;
        if (!init || !init.method) method = (input.method || 'GET').toUpperCase();
      } else {
        url = String(input);
      }
      var requestSize = 0;
      if (init && init.body) {
        try { requestSize = typeof init.body === 'string' ? init.body.length : (init.body.byteLength || init.body.size || 0); } catch (_) {}
      }
      var start = Date.now();
      var entry = {
        method: method, url: url, status: 0, duration: 0,
        requestSize: requestSize, responseSize: 0,
        type: 'fetch', timestamp: start, error: null
      };
      return origFetch.apply(window, arguments).then(function (response) {
        entry.status = response.status;
        entry.duration = Date.now() - start;
        var cl = response.headers.get('content-length');
        if (cl) entry.responseSize = parseInt(cl, 10) || 0;
        networkLog.push(entry);
        if (networkLog.length > NETWORK_LOG_CAP) networkLog.shift();
        return response;
      }, function (err) {
        entry.duration = Date.now() - start;
        entry.error = err ? (err.message || String(err)) : 'Network error';
        networkLog.push(entry);
        if (networkLog.length > NETWORK_LOG_CAP) networkLog.shift();
        throw err;
      });
    };

    // Patch XHR
    origXhrOpen = XMLHttpRequest.prototype.open;
    origXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__fb_method = (method || 'GET').toUpperCase();
      this.__fb_url = url;
      return origXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      var start = Date.now();
      var requestSize = 0;
      if (body) {
        try { requestSize = typeof body === 'string' ? body.length : (body.byteLength || body.size || 0); } catch (_) {}
      }
      xhr.addEventListener('loadend', function () {
        var entry = {
          method: xhr.__fb_method || 'GET',
          url: xhr.__fb_url || '',
          status: xhr.status || 0,
          duration: Date.now() - start,
          requestSize: requestSize,
          responseSize: 0,
          type: 'xhr',
          timestamp: start,
          error: null
        };
        try {
          var cl = xhr.getResponseHeader('content-length');
          if (cl) {
            entry.responseSize = parseInt(cl, 10) || 0;
          } else if (xhr.responseText) {
            entry.responseSize = xhr.responseText.length;
          }
        } catch (_) {}
        if (xhr.status === 0) entry.error = 'Network error';
        networkLog.push(entry);
        if (networkLog.length > NETWORK_LOG_CAP) networkLog.shift();
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  // --- WebSocket logging ---

  var wsLog = [];
  var WS_LOG_CAP = 100;
  var wsLogging = false;
  var OrigWebSocket = null;

  function startWsLog() {
    if (wsLogging) return;
    wsLogging = true;
    OrigWebSocket = window.WebSocket;

    var origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (wsLogging) {
        var size = 0;
        var dataStr = '';
        try {
          if (typeof data === 'string') {
            size = data.length;
            dataStr = data.substring(0, 500);
          } else if (data && data.byteLength !== undefined) {
            size = data.byteLength;
            dataStr = '[binary ' + size + ' bytes]';
          } else if (data && data.size !== undefined) {
            size = data.size;
            dataStr = '[blob ' + size + ' bytes]';
          }
        } catch (_) {}
        wsLog.push({
          url: this.url || '',
          direction: 'send',
          data: dataStr,
          size: size,
          timestamp: Date.now()
        });
        if (wsLog.length > WS_LOG_CAP) wsLog.shift();
      }
      return origSend.apply(this, arguments);
    };

    // Patch constructor to intercept incoming messages
    window.WebSocket = function (url, protocols) {
      var ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
      ws.addEventListener('message', function (event) {
        if (!wsLogging) return;
        var size = 0;
        var dataStr = '';
        try {
          if (typeof event.data === 'string') {
            size = event.data.length;
            dataStr = event.data.substring(0, 500);
          } else if (event.data && event.data.byteLength !== undefined) {
            size = event.data.byteLength;
            dataStr = '[binary ' + size + ' bytes]';
          } else if (event.data && event.data.size !== undefined) {
            size = event.data.size;
            dataStr = '[blob ' + size + ' bytes]';
          }
        } catch (_) {}
        wsLog.push({
          url: ws.url || url,
          direction: 'receive',
          data: dataStr,
          size: size,
          timestamp: Date.now()
        });
        if (wsLog.length > WS_LOG_CAP) wsLog.shift();
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  }

  // --- Helpers ---

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };

  var IMPLICIT_ROLES = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textbox', IMG: 'img', NAV: 'navigation', MAIN: 'main',
    HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
    FORM: 'form', TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading',
    H5: 'heading', H6: 'heading', ARTICLE: 'article', SECTION: 'region',
    DIALOG: 'dialog', DETAILS: 'group', SUMMARY: 'button',
    PROGRESS: 'progressbar', METER: 'meter', OUTPUT: 'status'
  };

  var SNAPSHOT_ATTRS = ['id', 'class', 'name', 'type', 'href', 'src', 'placeholder', 'data-testid', 'aria-label'];

  function isVisible(el) {
    try {
      var rect = el.getBoundingClientRect();
      var style = getComputedStyle(el);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;
    } catch (_) {
      return false;
    }
  }

  function getBounds(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function getRole(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName;
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return IMPLICIT_ROLES[tag] || null;
  }

  function directText(el) {
    var text = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) {
        text += el.childNodes[i].nodeValue || '';
      }
    }
    return text.trim().substring(0, 200);
  }

  function getHeadingLevel(el) {
    var m = el.tagName.match(/^H([1-6])$/);
    return m ? parseInt(m[1], 10) : null;
  }

  function getAccessibleName(el) {
    var label = el.getAttribute('aria-label');
    if (label) return label;
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = labelledBy.split(/\s+/);
      var names = [];
      for (var i = 0; i < parts.length; i++) {
        var ref = document.getElementById(parts[i]);
        if (ref) names.push((ref.textContent || '').trim());
      }
      if (names.length) return names.join(' ').substring(0, 200);
    }
    // For inputs, check associated label
    if (el.id) {
      var assocLabel = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
      if (assocLabel) return (assocLabel.textContent || '').trim().substring(0, 200);
    }
    // Visible text
    var text = (el.textContent || '').trim();
    if (text) return text.substring(0, 200);
    // alt text for images
    var alt = el.getAttribute('alt');
    if (alt) return alt;
    return '';
  }

  function bestSelector(el) {
    if (el.id) return '#' + el.id;
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';
    var name = el.getAttribute('name');
    if (name) {
      var tag = el.tagName.toLowerCase();
      return tag + '[name="' + name + '"]';
    }
    // Try to build a unique selector from tag + nth-of-type
    var tag = el.tagName.toLowerCase();
    if (el.parentElement) {
      var siblings = el.parentElement.querySelectorAll(':scope > ' + tag);
      if (siblings.length === 1) {
        var parentSel = bestSelector(el.parentElement);
        return parentSel + ' > ' + tag;
      }
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === el) {
          var parentSel = bestSelector(el.parentElement);
          return parentSel + ' > ' + tag + ':nth-of-type(' + (i + 1) + ')';
        }
      }
    }
    return tag;
  }

  function getLabelForField(el) {
    // aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    // aria-labelledby
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ref = document.getElementById(labelledBy.split(/\s+/)[0]);
      if (ref) return (ref.textContent || '').trim();
    }
    // <label for="...">
    if (el.id) {
      var label = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
      if (label) return (label.textContent || '').trim();
    }
    // Wrapping <label>
    var parent = el.closest('label');
    if (parent) {
      // Get label text excluding the field itself
      var clone = parent.cloneNode(true);
      var inputs = clone.querySelectorAll('input, select, textarea');
      for (var i = 0; i < inputs.length; i++) inputs[i].remove();
      return (clone.textContent || '').trim();
    }
    // placeholder as fallback
    var ph = el.getAttribute('placeholder');
    if (ph) return ph;
    return '';
  }

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

    // --- 1. domSnapshot ---

    domSnapshot: function (rootSelector, options) {
      rootSelector = rootSelector || 'body';
      options = options || {};
      var maxDepth = options.maxDepth !== undefined ? options.maxDepth : 8;
      var maxChildren = options.maxChildren !== undefined ? options.maxChildren : 50;
      var visibleOnly = options.visibleOnly !== undefined ? options.visibleOnly : true;

      var root;
      try {
        root = document.querySelector(rootSelector);
      } catch (_) {
        return null;
      }
      if (!root) return null;

      function buildNode(el, depth) {
        if (depth > maxDepth) return null;
        if (el.nodeType !== 1) return null;

        var tag = el.tagName.toUpperCase();
        if (SKIP_TAGS[tag]) return null;

        var vis = isVisible(el);
        if (visibleOnly && !vis) return null;

        var tagLower = el.tagName.toLowerCase();
        var role = getRole(el);
        var text = directText(el);

        // Collect relevant attributes
        var attrs = {};
        for (var i = 0; i < SNAPSHOT_ATTRS.length; i++) {
          var attrName = SNAPSHOT_ATTRS[i];
          var val = el.getAttribute(attrName);
          if (val != null && val !== '') attrs[attrName] = val;
        }
        // value for form elements
        if (tagLower === 'input' || tagLower === 'textarea' || tagLower === 'select') {
          attrs.value = el.value || '';
        }

        // Build children (skip SVG internals)
        var children = [];
        if (tag !== 'SVG') {
          var childEls = el.children;
          var count = Math.min(childEls.length, maxChildren);
          for (var c = 0; c < count; c++) {
            var childNode = buildNode(childEls[c], depth + 1);
            if (childNode) children.push(childNode);
          }
        }

        var node = {
          tag: tagLower,
          role: role,
          text: text || undefined,
          attributes: Object.keys(attrs).length ? attrs : undefined,
          visible: vis,
          bounds: getBounds(el),
          children: children.length ? children : undefined
        };

        // Collapse: no semantic content, only one child
        if (!text && !role && !attrs.id && !attrs['data-testid'] && children.length === 1) {
          return children[0];
        }

        return node;
      }

      return buildNode(root, 0);
    },

    // --- 2. queryElements ---

    queryElements: function (selector, options) {
      options = options || {};
      var limit = options.limit !== undefined ? options.limit : 20;
      var results = [];
      var els;
      try {
        els = document.querySelectorAll(selector);
      } catch (_) {
        return results;
      }
      var count = Math.min(els.length, limit);
      for (var i = 0; i < count; i++) {
        var el = els[i];
        var tag = el.tagName.toLowerCase();
        var pickAttrs = {};
        var attrNames = ['class', 'id', 'type', 'data-testid', 'aria-label', 'disabled', 'href', 'name', 'role'];
        for (var a = 0; a < attrNames.length; a++) {
          var v = el.getAttribute(attrNames[a]);
          if (v != null && v !== '') pickAttrs[attrNames[a]] = v;
        }
        // disabled is a boolean attr
        if (el.hasAttribute('disabled')) pickAttrs.disabled = 'true';

        var entry = {
          index: i,
          tag: tag,
          text: (el.textContent || '').trim().substring(0, 200),
          visible: isVisible(el),
          bounds: getBounds(el),
          attributes: pickAttrs
        };

        // Checkbox / radio
        if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          entry.checked = el.checked;
        }
        // Value for inputs/textareas/selects
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          entry.value = el.value || '';
        }
        // Selected option text for selects
        if (tag === 'select' && el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
          entry.selectedOption = el.options[el.selectedIndex].text;
        }

        results.push(entry);
      }
      return results;
    },

    // --- 3. Network logging ---

    startNetworkLog: function () {
      startNetworkLog();
    },

    getNetworkLog: function () {
      return networkLog.slice();
    },

    clearNetworkLog: function () {
      networkLog.length = 0;
    },

    // --- 4. Console capture ---

    getConsoleLogs: function (since) {
      if (since) {
        return consoleLogs.filter(function (e) { return e.timestamp >= since; });
      }
      return consoleLogs.slice();
    },

    clearConsoleLogs: function () {
      consoleLogs.length = 0;
    },

    // --- 5. WebSocket logging ---

    startWsLog: function () {
      startWsLog();
    },

    getWsLog: function () {
      return wsLog.slice();
    },

    clearWsLog: function () {
      wsLog.length = 0;
    },

    // --- 6. getFormFields ---

    getFormFields: function (formSelector) {
      var form;
      try {
        form = document.querySelector(formSelector || 'form');
      } catch (_) {
        return [];
      }
      if (!form) return [];

      var fields = form.querySelectorAll('input, textarea, select');
      var results = [];
      for (var i = 0; i < fields.length; i++) {
        var el = fields[i];
        var tag = el.tagName.toLowerCase();
        var type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text');

        var entry = {
          label: getLabelForField(el),
          selector: bestSelector(el),
          tag: tag,
          type: type,
          value: el.value || '',
          required: el.required || el.hasAttribute('required'),
          disabled: el.disabled || el.hasAttribute('disabled'),
          options: null
        };

        if (tag === 'select') {
          entry.options = [];
          for (var o = 0; o < el.options.length; o++) {
            var opt = el.options[o];
            entry.options.push({ value: opt.value, text: opt.text, selected: opt.selected });
          }
        }

        results.push(entry);
      }
      return results;
    },

    // --- 7. getAccessibilityTree ---

    getAccessibilityTree: function (rootSelector) {
      var root;
      try {
        root = document.querySelector(rootSelector || 'body');
      } catch (_) {
        return null;
      }
      if (!root) return null;

      var SKIP_ROLES = { presentation: 1, none: 1 };

      function buildA11yNode(el) {
        if (el.nodeType !== 1) return null;
        var tag = el.tagName.toUpperCase();
        if (SKIP_TAGS[tag]) return null;

        // Skip hidden elements
        if (!isVisible(el)) return null;

        var role = getRole(el);
        var explicitRole = el.getAttribute('role');

        // Skip presentational/decorative
        if (explicitRole && SKIP_ROLES[explicitRole]) return null;

        // Skip decorative images
        if (tag === 'IMG' && el.getAttribute('alt') === '') return null;

        var name = getAccessibleName(el);

        // Build children
        var children = [];
        var childEls = el.children;
        for (var i = 0; i < childEls.length; i++) {
          var childNode = buildA11yNode(childEls[i]);
          if (childNode) children.push(childNode);
        }

        // If no role and no meaningful name, just return children (flatten)
        if (!role && !name) {
          return children.length === 1 ? children[0] : (children.length > 1 ? { role: null, name: '', children: children } : null);
        }

        var node = {
          role: role || tag.toLowerCase(),
          name: name,
          children: children.length ? children : undefined
        };

        // Add heading level
        var level = getHeadingLevel(el);
        if (level) node.level = level;

        // Add disabled state
        if (el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
          node.disabled = true;
        }

        return node;
      }

      return buildA11yNode(root);
    },

    ready: false,
  };

  hookReactRenders();

  window.__fb.ready = true;
})();
