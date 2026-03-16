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

  function stripCssFormatting(args) {
    if (!args || args.length === 0) return args;
    var first = args[0];
    if (typeof first !== 'string') return args;
    var cleaned = [];
    var parts = first.split('%c');
    var styleArgCount = parts.length - 1;
    cleaned.push(parts.join(''));
    // Skip the style arguments (one per %c)
    for (var i = 1; i < args.length; i++) {
      if (styleArgCount > 0) {
        styleArgCount--;
        continue;
      }
      cleaned.push(args[i]);
    }
    return cleaned;
  }

  function formatArgs(args) {
    try {
      var cleaned = stripCssFormatting(args);
      return cleaned
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
  var origXhrSetHeader = null;

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
      var reqHeaders = null;
      if (init && init.headers) {
        try {
          if (typeof init.headers === 'object' && !(init.headers instanceof Headers)) {
            reqHeaders = {};
            var hk = Object.keys(init.headers);
            for (var hi = 0; hi < hk.length; hi++) reqHeaders[hk[hi]] = init.headers[hk[hi]];
          } else if (init.headers instanceof Headers) {
            reqHeaders = {};
            init.headers.forEach(function (v, k) { reqHeaders[k] = v; });
          }
        } catch (_) {}
      }
      var entry = {
        method: method, url: url, status: 0, duration: 0,
        requestSize: requestSize, responseSize: 0,
        type: 'fetch', timestamp: start, error: null,
        requestHeaders: reqHeaders,
        responseHeaders: null,
        body: null
      };
      return origFetch.apply(window, arguments).then(function (response) {
        entry.status = response.status;
        entry.duration = Date.now() - start;
        var cl = response.headers.get('content-length');
        if (cl) entry.responseSize = parseInt(cl, 10) || 0;
        // Capture key response headers
        try {
          var rh = {};
          var ct = response.headers.get('content-type');
          if (ct) rh['content-type'] = ct;
          var cc = response.headers.get('cache-control');
          if (cc) rh['cache-control'] = cc;
          if (response.headers.get('set-cookie')) rh['set-cookie'] = '(present)';
          entry.responseHeaders = rh;
        } catch (_) {}
        // Clone and capture body for small responses
        try {
          var clone = response.clone();
          clone.text().then(function (t) {
            entry.body = t.substring(0, 2048);
          }).catch(function () {});
        } catch (_) {}
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

    origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (!this.__fb_reqHeaders) this.__fb_reqHeaders = {};
      this.__fb_reqHeaders[name] = value;
      return origXhrSetHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__fb_method = (method || 'GET').toUpperCase();
      this.__fb_url = url;
      this.__fb_reqHeaders = {};
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
          error: null,
          requestHeaders: xhr.__fb_reqHeaders || null,
          responseHeaders: null,
          body: null
        };
        try {
          var cl = xhr.getResponseHeader('content-length');
          if (cl) {
            entry.responseSize = parseInt(cl, 10) || 0;
          } else if (xhr.responseText) {
            entry.responseSize = xhr.responseText.length;
          }
        } catch (_) {}
        // Capture response headers
        try {
          var allHeaders = xhr.getAllResponseHeaders();
          if (allHeaders) {
            var parsed = parseResponseHeaders(allHeaders);
            entry.responseHeaders = pickResponseHeaders(parsed);
          }
        } catch (_) {}
        // Capture response body (first 2KB)
        try {
          if (xhr.responseText) {
            entry.body = xhr.responseText.substring(0, 2048);
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

  // --- CSS Inspector helpers ---

  var CSS_LAYOUT_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding',
    'box-sizing', 'overflow', 'z-index', 'opacity'
  ];
  var CSS_VISUAL_PROPS = [
    'background-color', 'color', 'font-family', 'font-size', 'font-weight',
    'line-height', 'border', 'border-radius', 'box-shadow'
  ];
  var CSS_FLEX_GRID_PROPS = [
    'flex-direction', 'justify-content', 'align-items', 'gap',
    'grid-template-columns', 'grid-template-rows'
  ];
  var CSS_INHERITED_PROPS = ['color', 'font-family', 'font-size', 'line-height'];
  var ALL_AUDIT_PROPS = CSS_LAYOUT_PROPS.concat(CSS_VISUAL_PROPS).concat(CSS_FLEX_GRID_PROPS);

  function createsStackingContext(el) {
    try {
      var s = getComputedStyle(el);
      var pos = s.position;
      var zIdx = s.zIndex;
      if ((pos === 'absolute' || pos === 'relative' || pos === 'fixed' || pos === 'sticky') && zIdx !== 'auto') return 'position+zIndex';
      if (pos === 'fixed' || pos === 'sticky') return 'position:' + pos;
      if (parseFloat(s.opacity) < 1) return 'opacity';
      if (s.transform && s.transform !== 'none') return 'transform';
      if (s.willChange && s.willChange !== 'auto') {
        var wc = s.willChange;
        if (wc.indexOf('transform') !== -1 || wc.indexOf('opacity') !== -1 || wc.indexOf('filter') !== -1) return 'will-change';
      }
      if (s.isolation === 'isolate') return 'isolation';
      if (s.filter && s.filter !== 'none') return 'filter';
      if (s.perspective && s.perspective !== 'none') return 'perspective';
      if (s.mixBlendMode && s.mixBlendMode !== 'normal') return 'mix-blend-mode';
      if (s.clipPath && s.clipPath !== 'none') return 'clip-path';
      if (s.mask && s.mask !== 'none') return 'mask';
      if (s.contain === 'layout' || s.contain === 'paint' || s.contain === 'strict' || s.contain === 'content') return 'contain';
    } catch (_) {}
    return null;
  }

  function parseSides(s, prop) {
    try {
      var top = parseFloat(s.getPropertyValue(prop + '-top')) || 0;
      var right = parseFloat(s.getPropertyValue(prop + '-right')) || 0;
      var bottom = parseFloat(s.getPropertyValue(prop + '-bottom')) || 0;
      var left = parseFloat(s.getPropertyValue(prop + '-left')) || 0;
      return { top: top, right: right, bottom: bottom, left: left };
    } catch (_) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
  }

  function parseBorderWidths(s) {
    try {
      return {
        top: parseFloat(s.borderTopWidth) || 0,
        right: parseFloat(s.borderRightWidth) || 0,
        bottom: parseFloat(s.borderBottomWidth) || 0,
        left: parseFloat(s.borderLeftWidth) || 0
      };
    } catch (_) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
  }

  function isOffScreen(r) {
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    return r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh;
  }

  function isClippedByAncestor(el) {
    var parent = el.parentElement;
    while (parent) {
      try {
        var ps = getComputedStyle(parent);
        if (ps.overflow === 'hidden' || ps.overflowX === 'hidden' || ps.overflowY === 'hidden') {
          var pr = parent.getBoundingClientRect();
          var er = el.getBoundingClientRect();
          if (er.right < pr.left || er.bottom < pr.top || er.left > pr.right || er.top > pr.bottom) return true;
        }
      } catch (_) {}
      parent = parent.parentElement;
    }
    return false;
  }

  // --- React fiber helpers ---

  function getFiber(el) {
    try {
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
          return el[keys[i]];
        }
      }
    } catch (_) {}
    return null;
  }

  function safeSerialize(val, depth) {
    if (depth === undefined) depth = 0;
    if (val === null || val === undefined) return val;
    var t = typeof val;
    if (t === 'boolean' || t === 'number' || t === 'string') return val;
    if (t === 'function') return '(function)';
    if (val && val.$$typeof) return '(ReactElement)';
    if (depth > 2) return '(object)';
    if (Array.isArray(val)) {
      var arr = [];
      for (var i = 0; i < Math.min(val.length, 10); i++) {
        arr.push(safeSerialize(val[i], depth + 1));
      }
      return arr;
    }
    if (t === 'object') {
      try {
        var result = {};
        var keys = Object.keys(val);
        for (var j = 0; j < Math.min(keys.length, 20); j++) {
          result[keys[j]] = safeSerialize(val[keys[j]], depth + 1);
        }
        var str = JSON.stringify(result);
        if (str && str.length > 500) return str.substring(0, 500) + '...';
        return result;
      } catch (_) {
        return '(object)';
      }
    }
    return String(val);
  }

  function extractFiberHooks(fiber) {
    var hooks = [];
    try {
      var hook = fiber.memoizedState;
      var idx = 0;
      while (hook && idx < 30) {
        var entry = { type: 'unknown', value: null };
        if (hook.queue !== null && hook.queue !== undefined) {
          if (hook.queue.lastRenderedReducer && hook.queue.lastRenderedReducer.name === 'basicStateReducer') {
            entry.type = 'useState';
          } else if (hook.queue.lastRenderedReducer) {
            entry.type = 'useReducer';
          } else {
            entry.type = 'useState';
          }
          entry.value = safeSerialize(hook.memoizedState);
        } else if (hook.memoizedState && hook.memoizedState._context) {
          entry.type = 'useContext';
          entry.value = safeSerialize(hook.memoizedState);
        } else if (hook.memoizedState && typeof hook.memoizedState === 'object' && hook.memoizedState.current !== undefined) {
          entry.type = 'useRef';
          entry.value = safeSerialize(hook.memoizedState.current);
        } else if (hook.memoizedState !== null && hook.memoizedState !== undefined) {
          entry.type = 'useMemo';
          entry.value = safeSerialize(hook.memoizedState);
        }
        hooks.push(entry);
        hook = hook.next;
        idx++;
      }
    } catch (_) {}
    return hooks;
  }

  // --- React profiler data ---
  var reactProfilerData = null;
  var origOnCommitFiberRoot = null;
  var reactProfilerActive = false;

  // --- Performance helpers ---

  var lcpEntries = [];
  var clsEntries = [];
  var longTaskEntries = [];
  var enhancedPerfObservers = [];

  function initEnhancedPerfObservers() {
    if (enhancedPerfObservers.length > 0) return;
    var configs = [
      { type: 'largest-contentful-paint', store: lcpEntries },
      { type: 'layout-shift', store: clsEntries },
      { type: 'longtask', store: longTaskEntries }
    ];
    for (var i = 0; i < configs.length; i++) {
      try {
        (function (cfg) {
          var obs = new PerformanceObserver(function (list) {
            var entries = list.getEntries();
            for (var j = 0; j < entries.length; j++) {
              cfg.store.push(entries[j]);
            }
          });
          obs.observe({ type: cfg.type, buffered: true });
          enhancedPerfObservers.push(obs);
        })(configs[i]);
      } catch (_) {}
    }
  }

  // --- Audit helpers ---

  function extractBgImage(el) {
    try {
      var bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
        return m ? m[1] : bg;
      }
    } catch (_) {}
    return null;
  }

  function guessFormat(src) {
    if (!src) return 'unknown';
    src = src.toLowerCase().split('?')[0];
    if (src.indexOf('.jpg') !== -1 || src.indexOf('.jpeg') !== -1) return 'jpg';
    if (src.indexOf('.png') !== -1) return 'png';
    if (src.indexOf('.webp') !== -1) return 'webp';
    if (src.indexOf('.avif') !== -1) return 'avif';
    if (src.indexOf('.svg') !== -1) return 'svg';
    if (src.indexOf('.gif') !== -1) return 'gif';
    return 'unknown';
  }

  function isInViewport(el) {
    try {
      var r = el.getBoundingClientRect();
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
    } catch (_) {
      return false;
    }
  }

  function getMeta(name, attr) {
    attr = attr || 'name';
    var el = document.querySelector('meta[' + attr + '="' + name + '"]');
    return el ? el.getAttribute('content') || '' : null;
  }

  function checkHeadingHierarchy() {
    var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    var lastLevel = 0;
    for (var i = 0; i < headings.length; i++) {
      var level = parseInt(headings[i].tagName.charAt(1), 10);
      if (level > lastLevel + 1 && lastLevel > 0) return false;
      lastLevel = level;
    }
    return true;
  }

  function countLinks(type) {
    var links = document.querySelectorAll('a[href]');
    var count = 0;
    var host = location.hostname;
    for (var i = 0; i < links.length; i++) {
      try {
        var href = links[i].href;
        if (!href) continue;
        var isInternal = href.indexOf(host) !== -1 || href.indexOf('/') === 0;
        if (type === 'internal' && isInternal) count++;
        if (type === 'external' && !isInternal) count++;
      } catch (_) {}
    }
    return count;
  }

  function getStructuredData() {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    var data = [];
    for (var i = 0; i < scripts.length; i++) {
      try {
        data.push(JSON.parse(scripts[i].textContent));
      } catch (_) {}
    }
    return data;
  }

  function getUsedFontFamilies() {
    var families = {};
    try {
      var els = document.body.querySelectorAll('*');
      var step = Math.max(1, Math.floor(els.length / 100));
      for (var i = 0; i < els.length; i += step) {
        if (isVisible(els[i])) {
          var ff = getComputedStyle(els[i]).fontFamily;
          if (ff) families[ff] = true;
        }
      }
    } catch (_) {}
    return Object.keys(families);
  }

  function parseResponseHeaders(headerStr) {
    var result = {};
    if (!headerStr) return result;
    var lines = headerStr.split('\r\n');
    for (var i = 0; i < lines.length; i++) {
      var idx = lines[i].indexOf(':');
      if (idx > 0) {
        var name = lines[i].substring(0, idx).trim().toLowerCase();
        result[name] = lines[i].substring(idx + 1).trim();
      }
    }
    return result;
  }

  function pickResponseHeaders(headers) {
    var picked = {};
    var keys = ['content-type', 'cache-control'];
    for (var i = 0; i < keys.length; i++) {
      if (headers[keys[i]]) picked[keys[i]] = headers[keys[i]];
    }
    // For set-cookie, only indicate presence
    if (headers['set-cookie']) picked['set-cookie'] = '(present)';
    return picked;
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

    getConsoleLogs: function (options) {
      var since = 0;
      var limit = 50;
      var offset = 0;
      var level = 'all';
      var filter = null;
      // Backwards compat: if called with a number, treat as since
      if (typeof options === 'number') {
        since = options;
      } else if (options && typeof options === 'object') {
        if (options.since) since = options.since;
        if (options.limit !== undefined) limit = options.limit;
        if (options.offset !== undefined) offset = options.offset;
        if (options.level) level = options.level;
        if (options.filter) filter = options.filter;
      }
      var results = [];
      for (var i = 0; i < consoleLogs.length; i++) {
        var e = consoleLogs[i];
        if (since && e.timestamp < since) continue;
        if (level !== 'all' && e.level !== level) continue;
        if (filter && e.message.indexOf(filter) === -1) continue;
        results.push(e);
      }
      if (offset > 0) results = results.slice(offset);
      if (limit > 0) results = results.slice(0, limit);
      return results;
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

    // --- CSS Inspector APIs ---

    cssAudit: function (selector) {
      try {
        var el = document.querySelector(selector);
        if (!el) return null;
        var s = getComputedStyle(el);
        var computed = {};
        for (var i = 0; i < ALL_AUDIT_PROPS.length; i++) {
          computed[ALL_AUDIT_PROPS[i]] = s.getPropertyValue(ALL_AUDIT_PROPS[i]);
        }
        // Inherited from parent chain
        var inherited = {};
        var parent = el.parentElement;
        if (parent) {
          var ps = getComputedStyle(parent);
          for (var j = 0; j < CSS_INHERITED_PROPS.length; j++) {
            inherited[CSS_INHERITED_PROPS[j]] = ps.getPropertyValue(CSS_INHERITED_PROPS[j]);
          }
        }
        // Stacking context info
        var reason = createsStackingContext(el);
        var parentCtx = null;
        var p = el.parentElement;
        while (p) {
          if (createsStackingContext(p)) {
            parentCtx = bestSelector(p);
            break;
          }
          p = p.parentElement;
        }
        return {
          selector: selector,
          element: {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: el.className ? String(el.className).split(/\s+/) : []
          },
          computed: computed,
          inherited: inherited,
          stacking: {
            zIndex: s.zIndex,
            createsContext: !!reason,
            parentContext: parentCtx
          }
        };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    getZIndexTree: function (rootSelector) {
      var results = [];
      try {
        var root = document.querySelector(rootSelector || 'body');
        if (!root) return results;
        function walkZ(el, depth) {
          var reason = createsStackingContext(el);
          if (reason) {
            var s = getComputedStyle(el);
            results.push({
              selector: bestSelector(el),
              tag: el.tagName.toLowerCase(),
              zIndex: s.zIndex,
              reason: reason,
              bounds: getBounds(el),
              depth: depth
            });
          }
          var children = el.children;
          for (var i = 0; i < children.length; i++) {
            walkZ(children[i], depth + (reason ? 1 : 0));
          }
        }
        walkZ(root, 0);
      } catch (e) {}
      return results;
    },

    computedLayout: function (selector) {
      try {
        var el = document.querySelector(selector);
        if (!el) return null;
        var s = getComputedStyle(el);
        var r = el.getBoundingClientRect();
        return {
          bounds: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          margin: parseSides(s, 'margin'),
          padding: parseSides(s, 'padding'),
          border: parseBorderWidths(s),
          overflow: { x: s.overflowX, y: s.overflowY },
          visibility: s.visibility,
          opacity: parseFloat(s.opacity),
          transforms: s.transform || 'none',
          position: s.position,
          isOffScreen: isOffScreen(r),
          isClipped: isClippedByAncestor(el)
        };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    cssDiff: function (selectorA, selectorB) {
      try {
        var elA = document.querySelector(selectorA);
        var elB = document.querySelector(selectorB);
        if (!elA || !elB) return [];
        var sA = getComputedStyle(elA);
        var sB = getComputedStyle(elB);
        var diffs = [];
        for (var i = 0; i < sA.length; i++) {
          var prop = sA[i];
          var vA = sA.getPropertyValue(prop);
          var vB = sB.getPropertyValue(prop);
          if (vA !== vB) {
            diffs.push({ property: prop, a: vA, b: vB });
          }
        }
        return diffs;
      } catch (e) {
        return [];
      }
    },

    // --- React DevTools Bridge ---

    getReactTree: function (rootSelector, maxDepth) {
      if (maxDepth === undefined) maxDepth = 6;
      try {
        var root = document.querySelector(rootSelector || 'body');
        if (!root) return null;
        var fiber = getFiber(root);
        if (!fiber) return { error: 'No React fiber found on element' };

        function buildFiberNode(f, depth) {
          if (!f || depth > maxDepth) return null;
          var isComponent = typeof f.type === 'function';
          var isSignificantHost = f.type && typeof f.type === 'string' && f.stateNode;
          if (!isComponent && !isSignificantHost) {
            // Skip internal fiber types, try children
            var child = f.child;
            if (child) return buildFiberNode(child, depth);
            return null;
          }
          var name = isComponent ? (f.type.displayName || f.type.name || 'Anonymous') : f.type;
          var node = {
            component: name,
            props: null,
            state: null,
            hooks: [],
            children: []
          };
          // Props
          if (f.memoizedProps) {
            var props = {};
            var pk = Object.keys(f.memoizedProps);
            for (var pi = 0; pi < pk.length; pi++) {
              if (pk[pi] === 'children') continue;
              props[pk[pi]] = safeSerialize(f.memoizedProps[pk[pi]]);
            }
            node.props = props;
          }
          // State (class components)
          if (f.memoizedState && isComponent && f.type.prototype && f.type.prototype.isReactComponent) {
            node.state = safeSerialize(f.memoizedState);
          }
          // Hooks (function components)
          if (isComponent && !(f.type.prototype && f.type.prototype.isReactComponent)) {
            node.hooks = extractFiberHooks(f);
          }
          // Render count if available
          if (f.actualDuration !== undefined) {
            node.renderDuration = Math.round(f.actualDuration * 100) / 100;
          }
          // Walk children
          var child = f.child;
          while (child) {
            var childNode = buildFiberNode(child, depth + 1);
            if (childNode) node.children.push(childNode);
            child = child.sibling;
          }
          return node;
        }

        return buildFiberNode(fiber, 0);
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    startReactProfiler: function () {
      try {
        var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found' };
        reactProfilerData = { commits: [], startTime: Date.now() };
        reactProfilerActive = true;
        origOnCommitFiberRoot = hook.onCommitFiberRoot;
        hook.onCommitFiberRoot = function (id, root) {
          if (reactProfilerActive && reactProfilerData) {
            var components = [];
            try {
              function collectComponents(fiber) {
                if (!fiber) return;
                if (typeof fiber.type === 'function') {
                  var name = fiber.type.displayName || fiber.type.name || 'Anonymous';
                  components.push(name);
                }
                collectComponents(fiber.child);
                collectComponents(fiber.sibling);
              }
              if (root && root.current) collectComponents(root.current);
            } catch (_) {}
            reactProfilerData.commits.push({
              timestamp: Date.now(),
              components: components,
              duration: 0
            });
          }
          if (origOnCommitFiberRoot) return origOnCommitFiberRoot.apply(this, arguments);
        };
        return { started: true };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    stopReactProfiler: function () {
      try {
        reactProfilerActive = false;
        var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (hook && origOnCommitFiberRoot) {
          hook.onCommitFiberRoot = origOnCommitFiberRoot;
          origOnCommitFiberRoot = null;
        }
        if (!reactProfilerData) return { error: 'Profiler was not started' };
        var data = reactProfilerData;
        reactProfilerData = null;
        // Calculate per-component render counts
        var renderCounts = {};
        for (var i = 0; i < data.commits.length; i++) {
          var comps = data.commits[i].components;
          for (var j = 0; j < comps.length; j++) {
            renderCounts[comps[j]] = (renderCounts[comps[j]] || 0) + 1;
          }
        }
        // Identify potentially wasted renders (component rendered in consecutive commits)
        var wastedRenders = {};
        for (var ci = 1; ci < data.commits.length; ci++) {
          var prev = data.commits[ci - 1].components;
          var curr = data.commits[ci].components;
          for (var k = 0; k < curr.length; k++) {
            if (prev.indexOf(curr[k]) !== -1) {
              wastedRenders[curr[k]] = (wastedRenders[curr[k]] || 0) + 1;
            }
          }
        }
        return {
          duration: Date.now() - data.startTime,
          commits: data.commits,
          renderCounts: renderCounts,
          wastedRenders: wastedRenders
        };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    // --- Performance APIs ---

    getResourceTiming: function () {
      try {
        var entries = performance.getEntriesByType('resource');
        return entries.map(function (entry) {
          return {
            name: entry.name,
            type: entry.initiatorType,
            size: entry.transferSize,
            decodedSize: entry.decodedBodySize,
            duration: Math.round(entry.duration),
            timing: {
              dns: Math.round(entry.domainLookupEnd - entry.domainLookupStart),
              tcp: Math.round(entry.connectEnd - entry.connectStart),
              tls: Math.round(entry.secureConnectionStart ? entry.connectEnd - entry.secureConnectionStart : 0),
              ttfb: Math.round(entry.responseStart - entry.requestStart),
              download: Math.round(entry.responseEnd - entry.responseStart)
            },
            cached: entry.transferSize === 0 && entry.decodedBodySize > 0,
            renderBlocking: entry.renderBlockingStatus || 'unknown'
          };
        });
      } catch (e) {
        return [];
      }
    },

    getEnhancedPerfMetrics: function () {
      try {
        initEnhancedPerfObservers();
        // FCP
        var fcp = null;
        try {
          var fcpEntries = performance.getEntriesByName('first-contentful-paint');
          if (fcpEntries.length > 0) fcp = Math.round(fcpEntries[0].startTime);
        } catch (_) {}
        // LCP
        var lcp = null;
        if (lcpEntries.length > 0) {
          lcp = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
        }
        // CLS
        var cls = 0;
        for (var ci = 0; ci < clsEntries.length; ci++) {
          if (clsEntries[ci].value) cls += clsEntries[ci].value;
        }
        cls = Math.round(cls * 10000) / 10000;
        // Navigation timing
        var ttfb = null;
        var domInteractive = null;
        var domComplete = null;
        try {
          var t = performance.timing;
          if (t) {
            ttfb = t.responseStart - t.navigationStart;
            domInteractive = t.domInteractive - t.navigationStart;
            domComplete = t.domComplete > 0 ? t.domComplete - t.navigationStart : null;
          }
        } catch (_) {}
        // Long tasks
        var ltCount = longTaskEntries.length;
        var ltTotal = 0;
        var ltEntries = [];
        for (var li = 0; li < longTaskEntries.length; li++) {
          ltTotal += longTaskEntries[li].duration;
          if (li < 20) {
            ltEntries.push({
              startTime: Math.round(longTaskEntries[li].startTime),
              duration: Math.round(longTaskEntries[li].duration)
            });
          }
        }
        // Memory
        var heapMB = null;
        var heapLimitMB = null;
        try {
          if (performance.memory) {
            heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10;
            heapLimitMB = Math.round(performance.memory.jsHeapSizeLimit / 1048576 * 10) / 10;
          }
        } catch (_) {}
        return {
          navigation: {
            ttfb: ttfb,
            fcp: fcp,
            lcp: lcp,
            cls: cls,
            domInteractive: domInteractive,
            domComplete: domComplete
          },
          longTasks: {
            count: ltCount,
            totalMs: Math.round(ltTotal),
            entries: ltEntries
          },
          domNodes: document.querySelectorAll('*').length,
          heapMB: heapMB,
          heapLimitMB: heapLimitMB
        };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    // --- Audit APIs ---

    getImagesAudit: function () {
      try {
        var els = document.querySelectorAll('img, picture source, [style*="background-image"]');
        var results = [];
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var src = el.src || el.srcset || extractBgImage(el);
          var nw = el.naturalWidth || null;
          var nh = el.naturalHeight || null;
          var rw = el.width || el.offsetWidth || 0;
          var rh = el.height || el.offsetHeight || 0;
          results.push({
            src: src,
            naturalWidth: nw,
            naturalHeight: nh,
            renderedWidth: rw,
            renderedHeight: rh,
            oversized: nw ? nw > rw * 2 : false,
            loading: el.loading || 'eager',
            alt: el.getAttribute('alt'),
            missingAlt: el.tagName === 'IMG' && !el.hasAttribute('alt'),
            format: guessFormat(src),
            inViewport: isInViewport(el),
            lazyCandidate: !isInViewport(el) && el.loading !== 'lazy'
          });
        }
        return results;
      } catch (e) {
        return [];
      }
    },

    getFontsAudit: function () {
      try {
        var loaded = [];
        try {
          var fonts = document.fonts;
          fonts.forEach(function (f) {
            if (f.status === 'loaded') {
              loaded.push({
                family: f.family,
                weight: f.weight,
                style: f.style,
                status: f.status
              });
            }
          });
        } catch (_) {}
        var fontFaces = [];
        try {
          var sheets = document.styleSheets;
          for (var i = 0; i < sheets.length; i++) {
            try {
              var rules = sheets[i].cssRules;
              for (var j = 0; j < rules.length; j++) {
                if (rules[j] instanceof CSSFontFaceRule) {
                  fontFaces.push({
                    family: rules[j].style.fontFamily,
                    src: rules[j].style.src,
                    weight: rules[j].style.fontWeight,
                    display: rules[j].style.fontDisplay || 'auto'
                  });
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
        return {
          loaded: loaded,
          fontFaces: fontFaces,
          usedFamilies: getUsedFontFamilies()
        };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    getSEOAudit: function () {
      try {
        return {
          title: document.title,
          meta: {
            description: getMeta('description'),
            viewport: getMeta('viewport'),
            robots: getMeta('robots'),
            canonical: (document.querySelector('link[rel=canonical]') || {}).href || null,
            ogTitle: getMeta('og:title', 'property'),
            ogDescription: getMeta('og:description', 'property'),
            ogImage: getMeta('og:image', 'property'),
            twitterCard: getMeta('twitter:card')
          },
          headings: {
            h1: Array.prototype.slice.call(document.querySelectorAll('h1')).map(function (h) { return (h.textContent || '').trim().substring(0, 100); }),
            h2Count: document.querySelectorAll('h2').length,
            h3Count: document.querySelectorAll('h3').length,
            hierarchyValid: checkHeadingHierarchy()
          },
          images: {
            total: document.images.length,
            missingAlt: Array.prototype.slice.call(document.images).filter(function (img) { return !img.hasAttribute('alt'); }).length
          },
          links: {
            internal: countLinks('internal'),
            external: countLinks('external'),
            nofollow: document.querySelectorAll('a[rel*=nofollow]').length
          },
          structuredData: getStructuredData()
        };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },

    ready: false,
  };

  hookReactRenders();

  window.__fb.ready = true;
})();
