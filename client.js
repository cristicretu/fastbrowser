/**
 * fastbrowser/client — optional app integration helper.
 * Drop into your app to expose state, restore, and perf markers to the agent.
 *
 * @example
 * import { initFastBrowser, withFastBrowser } from 'fastbrowser/client'
 *
 * initFastBrowser({
 *   getState: () => myAppState,
 *   restoreState: (s) => loadState(s),
 * })
 *
 * export const useEditorStore = withFastBrowser('editor', create((set) => ({ ... })))
 */

export function initFastBrowser({ getState, restoreState, perfMarkers } = {}) {
  if (process.env.NODE_ENV === 'production') return;
  if (typeof window === 'undefined') return;

  if (getState) {
    window.__FB_APP_STATE__ = getState;
  }

  if (restoreState) {
    window.__FB_RESTORE_STATE__ = restoreState;
  }

  if (perfMarkers) {
    window.__FB_PERF_MARKERS__ = perfMarkers;
  }

  // Hook React render counting if devtools hook is present and bridge hasn't already patched it
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

export function withFastBrowser(storeName, useStore) {
  if (process.env.NODE_ENV === 'production') return useStore;
  if (typeof window === 'undefined') return useStore;

  window.__FB_STORES__ = window.__FB_STORES__ || {};
  window.__FB_STORES__[storeName] = useStore;

  // Auto-wire getState across all registered stores
  window.__FB_APP_STATE__ = function () {
    var stores = window.__FB_STORES__;
    var state = {};
    var names = Object.keys(stores);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      try {
        state[name] = stores[name].getState();
      } catch (_) {}
    }
    return state;
  };

  // Auto-wire restoreState across all registered stores
  window.__FB_RESTORE_STATE__ = function (appState) {
    if (!appState) return;
    var stores = window.__FB_STORES__;
    var names = Object.keys(appState);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (stores[name] && typeof stores[name].setState === 'function') {
        try {
          stores[name].setState(appState[name]);
        } catch (_) {}
      }
    }
  };

  return useStore;
}
