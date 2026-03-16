#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import puppeteer from "puppeteer";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CFG = {
  url: process.env.FASTBROWSER_URL || "http://localhost:3000",
  headless: (process.env.FASTBROWSER_HEADLESS ?? "true") === "true",
  outputDir: process.env.FASTBROWSER_OUTPUT || "/tmp/fastbrowser",
  viewport: (() => {
    const v = (process.env.FASTBROWSER_VIEWPORT || "1280x800").split("x");
    return { width: parseInt(v[0], 10), height: parseInt(v[1], 10) };
  })(),
  defaultTimeout: parseInt(process.env.FASTBROWSER_DEFAULT_TIMEOUT || "200", 10),
};

fs.mkdirSync(CFG.outputDir, { recursive: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function dirname(f) { return path.dirname(f); }

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------
let browser = null;
let page = null;
let lastKnownURL = CFG.url;
let bridgeCode = null;

function loadBridge() {
  if (bridgeCode) return bridgeCode;
  const p = path.join(__dirname, "bridge.js");
  if (fs.existsSync(p)) {
    bridgeCode = fs.readFileSync(p, "utf-8");
  }
  return bridgeCode;
}

async function ensureBrowser() {
  if (browser && browser.connected) return page;
  browser = await puppeteer.launch({
    headless: CFG.headless ? "new" : false,
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-sandbox",
    ],
  });
  page = await browser.newPage();
  await page.setViewport(CFG.viewport);
  await injectBridge(page);
  await page.goto(CFG.url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  lastKnownURL = page.url();
  return page;
}

async function injectBridge(pg) {
  const code = loadBridge();
  if (!code) return;
  await pg.evaluateOnNewDocument(code);
  try { await pg.evaluate(code); } catch {}
}

async function ensurePage() {
  await ensureBrowser();
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await page.setViewport(CFG.viewport);
    await injectBridge(page);
    if (lastKnownURL) {
      await page.goto(lastKnownURL, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    }
  }
  return page;
}

// ---------------------------------------------------------------------------
// Network idle helper
// ---------------------------------------------------------------------------
function waitForNetworkIdle(pg, timeout = 2000, idleTime = 500) {
  return new Promise((resolve, reject) => {
    let inflight = 0;
    let idleTimer = null;
    let done = false;

    const timer = setTimeout(() => { finish(); }, timeout);

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      pg.off("request", onReq);
      pg.off("requestfinished", onDone);
      pg.off("requestfailed", onDone);
      if (err) reject(err); else resolve();
    }

    function checkIdle() {
      if (inflight === 0) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(), idleTime);
      } else {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      }
    }

    function onReq() { inflight++; checkIdle(); }
    function onDone() { inflight = Math.max(0, inflight - 1); checkIdle(); }

    pg.on("request", onReq);
    pg.on("requestfinished", onDone);
    pg.on("requestfailed", onDone);

    checkIdle();
  });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------
const checkpoints = new Map();

// ---------------------------------------------------------------------------
// Module-level state for network intercept, logging flags
// ---------------------------------------------------------------------------
let networkLogStarted = false;
let wsLogStarted = false;
const interceptsMap = new Map();
let interceptEnabled = false;
let interceptCounter = 0;
const baselines = new Map();
let profilerSession = null;
const heapSnapshots = new Map();

// ---------------------------------------------------------------------------
// Step executor
// ---------------------------------------------------------------------------
async function executeStep(pg, step) {
  const t0 = Date.now();
  const result = { action: step.action, ok: true, ms: 0 };

  try {
    switch (step.action) {
      case "click": {
        if (step.coords) {
          await pg.mouse.click(step.coords[0], step.coords[1]);
        } else {
          await pg.click(step.selector);
        }
        break;
      }
      case "type": {
        if (step.selector) await pg.click(step.selector).catch(() => {});
        await pg.keyboard.type(step.text, { delay: step.delay || 0 });
        break;
      }
      case "press": {
        await pg.keyboard.press(step.key);
        break;
      }
      case "scroll": {
        await pg.mouse.wheel({ deltaX: step.deltaX || 0, deltaY: step.deltaY || 0 });
        break;
      }
      case "hover": {
        if (step.coords) {
          await pg.mouse.move(step.coords[0], step.coords[1]);
        } else {
          await pg.hover(step.selector);
        }
        break;
      }
      case "waitFor": {
        const timeout = step.timeout ?? CFG.defaultTimeout;
        await pg.waitForSelector(step.selector, { visible: true, timeout });
        break;
      }
      case "waitForGone": {
        const timeout = step.timeout ?? CFG.defaultTimeout;
        await pg.waitForSelector(step.selector, { hidden: true, timeout });
        break;
      }
      case "waitForNetwork": {
        const timeout = step.timeout ?? 2000;
        await waitForNetworkIdle(pg, timeout);
        break;
      }
      case "waitForFunction": {
        const timeout = step.timeout ?? CFG.defaultTimeout;
        await pg.waitForFunction(step.js, { timeout });
        break;
      }
      case "assertVisible": {
        const visible = await pg.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const s = getComputedStyle(el);
          return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && el.offsetWidth > 0;
        }, step.selector);
        if (!visible) throw new Error(`Element "${step.selector}" is not visible`);
        break;
      }
      case "assertText": {
        const text = await pg.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.textContent : null;
        }, step.selector);
        if (text === null) throw new Error(`Element "${step.selector}" not found`);
        if (step.equals !== undefined && text !== step.equals) {
          throw new Error(`Text mismatch: expected "${step.equals}", got "${text}"`);
        }
        if (step.contains !== undefined && !text.includes(step.contains)) {
          throw new Error(`Text does not contain "${step.contains}", got "${text}"`);
        }
        result.text = text;
        break;
      }
      case "assertCount": {
        const count = await pg.evaluate((sel) => document.querySelectorAll(sel).length, step.selector);
        if (count !== step.count) {
          throw new Error(`Count mismatch for "${step.selector}": expected ${step.count}, got ${count}`);
        }
        result.count = count;
        break;
      }
      case "assertURL": {
        const url = pg.url();
        if (step.equals !== undefined && url !== step.equals) {
          throw new Error(`URL mismatch: expected "${step.equals}", got "${url}"`);
        }
        if (step.contains !== undefined && !url.includes(step.contains)) {
          throw new Error(`URL does not contain "${step.contains}", got "${url}"`);
        }
        result.url = url;
        break;
      }
      case "eval": {
        const val = await pg.evaluate(step.js);
        result.value = val;
        break;
      }
      case "wait": {
        await new Promise((r) => setTimeout(r, step.ms));
        break;
      }
      case "navigate": {
        const waitUntil = step.waitUntil || "networkidle2";
        const timeout = step.timeout || 30000;
        await pg.goto(step.url, { waitUntil, timeout });
        lastKnownURL = pg.url();
        result.url = lastKnownURL;
        break;
      }
      case "screenshot": {
        const opts = { fullPage: step.fullPage || false };
        if (step.selector) {
          const el = await pg.$(step.selector);
          if (!el) throw new Error(`Element "${step.selector}" not found for screenshot`);
          opts.element = el;
        }
        const name = step.name || `screenshot-${Date.now()}`;
        const filePath = path.join(CFG.outputDir, `${name}.png`);
        if (opts.element) {
          await opts.element.screenshot({ path: filePath });
        } else {
          await pg.screenshot({ path: filePath, fullPage: opts.fullPage });
        }
        result.path = filePath;
        break;
      }
      case "fill": {
        await pg.click(step.selector, { clickCount: 3 });
        await pg.keyboard.type(step.value);
        break;
      }
      case "select": {
        await pg.select(step.selector, step.value);
        break;
      }
      case "upload": {
        const el = await pg.$(step.selector);
        if (!el) throw new Error(`File input "${step.selector}" not found`);
        await el.uploadFile(step.filePath);
        break;
      }
      case "dom_snapshot": {
        const opts = {
          maxDepth: step.maxDepth || 8,
          maxChildren: step.maxChildren || 50,
          visibleOnly: step.visibleOnly !== false,
        };
        result.snapshot = await pg.evaluate(
          (sel, o) => window.__fb.domSnapshot(sel, o),
          step.selector || "body",
          opts
        );
        break;
      }
      case "query": {
        result.elements = await pg.evaluate(
          (sel, o) => window.__fb.queryElements(sel, o),
          step.selector,
          { limit: step.limit || 20 }
        );
        break;
      }
      case "assert": {
        const details = {};
        let ok = true;
        const sel = step.selector;

        if (step.visible !== undefined) {
          const isVisible = await pg.evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            const st = getComputedStyle(el);
            return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0" && el.offsetWidth > 0;
          }, sel);
          details.visible = isVisible;
          if (isVisible !== step.visible) ok = false;
        }
        if (step.contains !== undefined || step.equals !== undefined) {
          const text = await pg.evaluate((s) => {
            const el = document.querySelector(s);
            return el ? el.textContent : null;
          }, sel);
          details.text = text;
          if (step.contains !== undefined && (text === null || !text.includes(step.contains))) ok = false;
          if (step.equals !== undefined && text !== step.equals) ok = false;
        }
        if (step.count !== undefined || step.minCount !== undefined || step.maxCount !== undefined) {
          const cnt = await pg.evaluate((s) => document.querySelectorAll(s).length, sel);
          details.count = cnt;
          if (step.count !== undefined && cnt !== step.count) ok = false;
          if (step.minCount !== undefined && cnt < step.minCount) ok = false;
          if (step.maxCount !== undefined && cnt > step.maxCount) ok = false;
        }
        if (step.hasAttribute !== undefined) {
          const has = await pg.evaluate((s, attr) => {
            const el = document.querySelector(s);
            return el ? el.hasAttribute(attr) : false;
          }, sel, step.hasAttribute);
          details.hasAttribute = has;
          if (!has) ok = false;
        }
        if (step.checked !== undefined) {
          const checked = await pg.evaluate((s) => {
            const el = document.querySelector(s);
            return el ? el.checked : null;
          }, sel);
          details.checked = checked;
          if (checked !== step.checked) ok = false;
        }
        if (step.url) {
          const currentUrl = pg.url();
          details.url = currentUrl;
          if (step.url.contains && !currentUrl.includes(step.url.contains)) ok = false;
          if (step.url.equals && currentUrl !== step.url.equals) ok = false;
        }

        if (!ok) throw new Error(`Assertion failed: ${JSON.stringify(details)}`);
        result.details = details;
        break;
      }
      case "form_fill": {
        const formSel = step.formSelector || "form";
        const fields = step.fields || {};
        const formFields = await pg.evaluate(
          (sel) => window.__fb.getFormFields(sel),
          formSel
        );
        const filledFields = [];
        const missingFields = [];
        for (const [label, value] of Object.entries(fields)) {
          const match = formFields.find(
            (f) => f.label && f.label.toLowerCase().includes(label.toLowerCase())
          ) || formFields.find(
            (f) => f.name && f.name.toLowerCase().includes(label.toLowerCase())
          ) || formFields.find(
            (f) => f.placeholder && f.placeholder.toLowerCase().includes(label.toLowerCase())
          );
          if (!match) {
            missingFields.push(label);
            continue;
          }
          if (match.type === "select" || match.tagName === "SELECT") {
            await pg.select(match.selector, value);
          } else if (match.type === "checkbox" || match.type === "radio") {
            const isChecked = await pg.evaluate(
              (s) => document.querySelector(s)?.checked,
              match.selector
            );
            const wantChecked = value === "true" || value === "1" || value === true;
            if (isChecked !== wantChecked) await pg.click(match.selector);
          } else {
            await pg.click(match.selector, { clickCount: 3 });
            await pg.keyboard.type(String(value));
          }
          filledFields.push(label);
        }
        result.filledFields = filledFields;
        result.missingFields = missingFields;
        break;
      }
      case "network_log": {
        if (!networkLogStarted) {
          await pg.evaluate(() => window.__fb.startNetworkLog());
          networkLogStarted = true;
        }
        const requests = await pg.evaluate(() => window.__fb.getNetworkLog());
        result.requests = requests;
        break;
      }
      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  } catch (err) {
    result.ok = false;
    result.reason = err.message || String(err);

    // Check for page crash and recover
    if (page && page.isClosed()) {
      try {
        page = await browser.newPage();
        await page.setViewport(CFG.viewport);
        await injectBridge(page);
        if (lastKnownURL) {
          await page.goto(lastKnownURL, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
        }
      } catch {}
      result.reason += " (page crashed — recovered)";
    }
  }

  result.ms = Date.now() - t0;
  return result;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "fastbrowser", version: "0.1.0" },
);

// ---- Tool: run ----
const StepSchema = z.object({
  action: z.string(),
  selector: z.string().optional(),
  coords: z.array(z.number()).length(2).optional(),
  text: z.string().optional(),
  delay: z.number().optional(),
  key: z.string().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  timeout: z.number().optional(),
  js: z.string().optional(),
  contains: z.string().optional(),
  equals: z.string().optional(),
  count: z.number().optional(),
  minCount: z.number().optional(),
  maxCount: z.number().optional(),
  ms: z.number().optional(),
  url: z.union([z.string(), z.object({ contains: z.string().optional(), equals: z.string().optional() })]).optional(),
  name: z.string().optional(),
  fullPage: z.boolean().optional(),
  value: z.string().optional(),
  filePath: z.string().optional(),
  waitUntil: z.string().optional(),
  // dom_snapshot step fields
  maxDepth: z.number().optional(),
  maxChildren: z.number().optional(),
  visibleOnly: z.boolean().optional(),
  // assert step fields
  visible: z.boolean().optional(),
  hasAttribute: z.string().optional(),
  checked: z.boolean().optional(),
  // form_fill step fields
  formSelector: z.string().optional(),
  fields: z.record(z.string()).optional(),
  // query step field
  limit: z.number().optional(),
}).passthrough();

server.tool(
  "run",
  "Execute a sequence of browser actions (click, type, assert, navigate, etc.)",
  {
    steps: z.array(StepSchema),
    continueOnFailure: z.boolean().default(false),
  },
  async ({ steps, continueOnFailure }) => {
    const pg = await ensurePage();
    const totalStart = Date.now();
    const results = [];

    // Start perf / clear errors via bridge
    await pg.evaluate(() => {
      if (window.__fb) { window.__fb.startPerf(); window.__fb.clearErrors(); }
    }).catch(() => {});

    let allOk = true;
    for (const step of steps) {
      const r = await executeStep(pg, step);
      results.push(r);
      if (!r.ok) {
        allOk = false;
        if (!continueOnFailure) break;
      }
    }

    // Stop perf / get errors via bridge
    let perf = {};
    let errors = [];
    try {
      perf = await pg.evaluate(() => window.__fb ? window.__fb.stopPerf() : {}) || {};
      errors = await pg.evaluate(() => window.__fb ? window.__fb.getErrors() : []) || [];
    } catch {}

    lastKnownURL = pg.url();
    const totalMs = Date.now() - totalStart;

    const summary = allOk
      ? `All ${results.length} steps passed in ${totalMs}ms`
      : `Failed at step ${results.findIndex((r) => !r.ok) + 1} of ${steps.length}`;

    const output = { ok: allOk, totalMs, steps: results, perf, errors, summary };

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  }
);

// ---- Tool: checkpoint ----
server.tool(
  "checkpoint",
  "Save browser state (cookies, storage, URL) to a named checkpoint",
  { name: z.string() },
  async ({ name }) => {
    const pg = await ensurePage();
    const cookies = await pg.cookies();
    const url = pg.url();
    const { localStorage: ls, sessionStorage: ss } = await pg.evaluate(() => {
      const toObj = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
      return { localStorage: toObj(localStorage), sessionStorage: toObj(sessionStorage) };
    });
    let appState = null;
    try {
      appState = await pg.evaluate(() =>
        typeof window.__FB_APP_STATE__ === "function" ? window.__FB_APP_STATE__() : null
      );
    } catch {}

    checkpoints.set(name, { cookies, url, localStorage: ls, sessionStorage: ss, appState });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          checkpoint: name,
          url,
          allCheckpoints: [...checkpoints.keys()],
        }),
      }],
    };
  }
);

// ---- Tool: restore ----
server.tool(
  "restore",
  "Restore browser state from a named checkpoint",
  { name: z.string() },
  async ({ name }) => {
    const cp = checkpoints.get(name);
    if (!cp) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: `Checkpoint "${name}" not found` }) }] };
    }
    const pg = await ensurePage();

    // Clear cookies and set checkpoint cookies
    const currentCookies = await pg.cookies();
    if (currentCookies.length) {
      await pg.deleteCookie(...currentCookies);
    }
    if (cp.cookies.length) {
      await pg.setCookie(...cp.cookies);
    }

    // Navigate only if URL differs
    const currentURL = pg.url();
    if (currentURL !== cp.url) {
      await pg.goto(cp.url, { waitUntil: "networkidle0", timeout: 30000 });
    }

    // Restore storage
    await pg.evaluate(({ ls, ss }) => {
      localStorage.clear();
      for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
      sessionStorage.clear();
      for (const [k, v] of Object.entries(ss)) sessionStorage.setItem(k, v);
    }, { ls: cp.localStorage, ss: cp.sessionStorage });

    // Restore app state
    if (cp.appState) {
      try {
        await pg.evaluate((state) => {
          if (typeof window.__FB_RESTORE_STATE__ === "function") window.__FB_RESTORE_STATE__(state);
        }, cp.appState);
      } catch {}
    }

    await pg.waitForFunction(() => document.readyState === "complete", { timeout: 5000 }).catch(() => {});

    lastKnownURL = pg.url();

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, restored: name, url: lastKnownURL }) }],
    };
  }
);

// ---- Tool: screenshot ----
server.tool(
  "screenshot",
  "Capture a screenshot of the current page or a specific element",
  {
    name: z.string().default("screenshot"),
    fullPage: z.boolean().default(false),
    selector: z.string().optional(),
  },
  async ({ name, fullPage, selector }) => {
    const pg = await ensurePage();
    const filePath = path.join(CFG.outputDir, `${name}.png`);

    if (selector) {
      const el = await pg.$(selector);
      if (!el) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: `Element "${selector}" not found` }) }] };
      }
      await el.screenshot({ path: filePath });
    } else {
      await pg.screenshot({ path: filePath, fullPage });
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, path: filePath }) }],
    };
  }
);

// ---- Tool: perf ----
server.tool(
  "perf",
  "Get a performance snapshot: DOM node count, memory, URL, title",
  {},
  async () => {
    const pg = await ensurePage();
    const data = await pg.evaluate(() => ({
      url: location.href,
      title: document.title,
      domNodes: document.querySelectorAll("*").length,
      readyState: document.readyState,
    }));

    let memory = null;
    try {
      memory = await pg.evaluate(() => {
        if (performance.memory) {
          return {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
          };
        }
        return null;
      });
    } catch {}

    return {
      content: [{ type: "text", text: JSON.stringify({ ...data, memory }) }],
    };
  }
);

// ---- Tool: eval ----
server.tool(
  "eval",
  "Execute arbitrary JavaScript in the browser page context",
  { js: z.string() },
  async ({ js }) => {
    const pg = await ensurePage();
    try {
      const result = await pg.evaluate(js);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, value: result }) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: navigate ----
server.tool(
  "navigate",
  "Navigate the browser to a URL and wait for network idle",
  {
    url: z.string(),
    waitUntil: z.string().default("networkidle2"),
    timeout: z.number().default(30000),
  },
  async ({ url, waitUntil, timeout }) => {
    const pg = await ensurePage();
    try {
      await pg.goto(url, { waitUntil, timeout });
      lastKnownURL = pg.url();
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, url: lastKnownURL }) }],
      };
    } catch (err) {
      lastKnownURL = pg.url();
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, url: lastKnownURL, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: status ----
server.tool(
  "status",
  "Check browser status, current URL, config, and available checkpoints",
  {},
  async () => {
    const booted = !!(browser && browser.connected);
    let url = null;
    if (booted && page && !page.isClosed()) {
      try { url = page.url(); } catch {}
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          booted,
          url,
          checkpoints: [...checkpoints.keys()],
          config: {
            targetURL: CFG.url,
            headless: CFG.headless,
            outputDir: CFG.outputDir,
            viewport: CFG.viewport,
            defaultTimeout: CFG.defaultTimeout,
          },
        }),
      }],
    };
  }
);

// ---- Tool: dom_snapshot ----
server.tool(
  "dom_snapshot",
  "Return a simplified semantic DOM tree of the page (replaces most screenshot needs)",
  {
    selector: z.string().default("body"),
    maxDepth: z.number().default(8),
    maxChildren: z.number().default(50),
    visibleOnly: z.boolean().default(true),
  },
  async ({ selector, maxDepth, maxChildren, visibleOnly }) => {
    const pg = await ensurePage();
    try {
      const tree = await pg.evaluate(
        (sel, opts) => window.__fb.domSnapshot(sel, opts),
        selector,
        { maxDepth, maxChildren, visibleOnly }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(tree, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: query ----
server.tool(
  "query",
  "CSS/aria selector returning matching elements with structured data",
  {
    selector: z.string(),
    limit: z.number().default(20),
  },
  async ({ selector, limit }) => {
    const pg = await ensurePage();
    try {
      const elements = await pg.evaluate(
        (sel, opts) => window.__fb.queryElements(sel, opts),
        selector,
        { limit }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(elements, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: assert ----
server.tool(
  "assert",
  "Fast pass/fail verification without screenshots",
  {
    selector: z.string(),
    visible: z.boolean().optional(),
    contains: z.string().optional(),
    equals: z.string().optional(),
    count: z.number().optional(),
    minCount: z.number().optional(),
    maxCount: z.number().optional(),
    hasAttribute: z.string().optional(),
    checked: z.boolean().optional(),
    url: z.object({
      contains: z.string().optional(),
      equals: z.string().optional(),
    }).optional(),
  },
  async ({ selector, visible, contains, equals, count, minCount, maxCount, hasAttribute, checked, url }) => {
    const pg = await ensurePage();
    try {
      const details = {};
      let ok = true;

      if (visible !== undefined) {
        const isVisible = await pg.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          const st = getComputedStyle(el);
          return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0" && el.offsetWidth > 0;
        }, selector);
        details.visible = isVisible;
        if (isVisible !== visible) ok = false;
      }

      if (contains !== undefined || equals !== undefined) {
        const text = await pg.evaluate((s) => {
          const el = document.querySelector(s);
          return el ? el.textContent : null;
        }, selector);
        details.text = text;
        if (contains !== undefined && (text === null || !text.includes(contains))) ok = false;
        if (equals !== undefined && text !== equals) ok = false;
      }

      if (count !== undefined || minCount !== undefined || maxCount !== undefined) {
        const cnt = await pg.evaluate((s) => document.querySelectorAll(s).length, selector);
        details.count = cnt;
        if (count !== undefined && cnt !== count) ok = false;
        if (minCount !== undefined && cnt < minCount) ok = false;
        if (maxCount !== undefined && cnt > maxCount) ok = false;
      }

      if (hasAttribute !== undefined) {
        const has = await pg.evaluate((s, attr) => {
          const el = document.querySelector(s);
          return el ? el.hasAttribute(attr) : false;
        }, selector, hasAttribute);
        details.hasAttribute = has;
        if (!has) ok = false;
      }

      if (checked !== undefined) {
        const ch = await pg.evaluate((s) => {
          const el = document.querySelector(s);
          return el ? el.checked : null;
        }, selector);
        details.checked = ch;
        if (ch !== checked) ok = false;
      }

      if (url) {
        const currentUrl = pg.url();
        details.url = currentUrl;
        if (url.contains && !currentUrl.includes(url.contains)) ok = false;
        if (url.equals && currentUrl !== url.equals) ok = false;
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok, details }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: network_log (enhanced) ----
server.tool(
  "network_log",
  "Return recent network requests with optional headers, body, timing, and filtering",
  {
    since: z.number().optional(),
    urlFilter: z.string().optional(),
    method: z.string().optional(),
    statusFilter: z.number().optional(),
    minDuration: z.number().optional(),
    limit: z.number().default(50),
    includeBody: z.boolean().default(false),
    includeHeaders: z.boolean().default(false),
  },
  async ({ since, urlFilter, method, statusFilter, minDuration, limit, includeBody, includeHeaders }) => {
    const pg = await ensurePage();
    try {
      if (!networkLogStarted) {
        await pg.evaluate(() => window.__fb.startNetworkLog());
        networkLogStarted = true;
      }

      let requests = await pg.evaluate(() => window.__fb ? window.__fb.getNetworkLog() : []) || [];

      if (since) requests = requests.filter((r) => (r.timestamp || 0) >= since);
      if (urlFilter) {
        try {
          const regex = new RegExp(urlFilter, "i");
          requests = requests.filter((r) => r.url && regex.test(r.url));
        } catch {
          requests = requests.filter((r) => r.url && r.url.includes(urlFilter));
        }
      }
      if (method) {
        const upperMethod = method.toUpperCase();
        requests = requests.filter((r) => (r.method || "").toUpperCase() === upperMethod);
      }
      if (statusFilter) requests = requests.filter((r) => r.status === statusFilter);
      if (minDuration) requests = requests.filter((r) => r.duration && r.duration >= minDuration);

      const allFiltered = requests;
      const byStatus = {};
      const byMethod = {};
      let totalDuration = 0;
      let totalSize = 0;
      let durationCount = 0;
      let slowest = null;
      const failed = [];

      for (const r of allFiltered) {
        const s = r.status || "pending";
        byStatus[s] = (byStatus[s] || 0) + 1;
        const m = r.method || "UNKNOWN";
        byMethod[m] = (byMethod[m] || 0) + 1;
        if (r.duration) {
          totalDuration += r.duration;
          durationCount++;
          if (!slowest || r.duration > slowest.duration) {
            slowest = { url: r.url, duration: r.duration, status: r.status };
          }
        }
        totalSize += r.responseSize || 0;
        if (r.status && r.status >= 400) {
          failed.push({ url: r.url, status: r.status, method: r.method });
        }
      }

      const summary = {
        total: allFiltered.length,
        byStatus,
        byMethod,
        avgDuration: durationCount ? Math.round(totalDuration / durationCount) : null,
        totalSize,
        slowest,
        failed: failed.slice(0, 10),
      };

      requests = allFiltered.slice(-limit);

      if (!includeBody || !includeHeaders) {
        requests = requests.map((r) => {
          const entry = { ...r };
          if (!includeBody) { delete entry.body; }
          if (!includeHeaders) { delete entry.requestHeaders; delete entry.responseHeaders; }
          return entry;
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, requests, summary }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: network_intercept ----
server.tool(
  "network_intercept",
  "Mock or delay specific API routes",
  {
    action: z.enum(["add", "remove", "list", "clear"]),
    urlPattern: z.string().optional(),
    method: z.string().optional(),
    response: z.object({
      status: z.number().default(200),
      body: z.string().optional(),
      headers: z.record(z.string()).optional(),
      delay: z.number().optional(),
    }).optional(),
    id: z.string().optional(),
  },
  async ({ action, urlPattern, method, response, id }) => {
    const pg = await ensurePage();
    try {
      switch (action) {
        case "add": {
          if (!urlPattern) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "urlPattern required for add" }) }] };
          }

          if (!interceptEnabled) {
            await pg.setRequestInterception(true);
            pg.on("request", (req) => {
              if (interceptsMap.size === 0) {
                req.continue();
                return;
              }
              const reqUrl = req.url();
              const reqMethod = req.method();
              for (const [, rule] of interceptsMap) {
                const urlMatch = reqUrl.includes(rule.urlPattern);
                const methodMatch = !rule.method || reqMethod.toUpperCase() === rule.method.toUpperCase();
                if (urlMatch && methodMatch) {
                  const resp = rule.response || {};
                  const respond = () => {
                    req.respond({
                      status: resp.status || 200,
                      contentType: (resp.headers && resp.headers["content-type"]) || "application/json",
                      headers: resp.headers || {},
                      body: resp.body || "",
                    });
                  };
                  if (resp.delay) {
                    setTimeout(respond, resp.delay);
                  } else {
                    respond();
                  }
                  return;
                }
              }
              req.continue();
            });
            interceptEnabled = true;
          }

          const interceptId = `intercept-${++interceptCounter}`;
          interceptsMap.set(interceptId, { urlPattern, method, response });

          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, id: interceptId, total: interceptsMap.size }) }],
          };
        }
        case "remove": {
          if (!id) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "id required for remove" }) }] };
          }
          const existed = interceptsMap.delete(id);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: existed, id, remaining: interceptsMap.size }) }],
          };
        }
        case "list": {
          const rules = [];
          for (const [ruleId, rule] of interceptsMap) {
            rules.push({ id: ruleId, urlPattern: rule.urlPattern, method: rule.method });
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, rules }) }],
          };
        }
        case "clear": {
          interceptsMap.clear();
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, cleared: true }) }],
          };
        }
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: console_log (enhanced) ----
function stripCSSFormatting(msg) {
  if (typeof msg !== 'string') return msg;
  return msg.replace(/%c/g, '');
}

server.tool(
  "console_log",
  "Return buffered console output with filtering and pagination (log, warn, error)",
  {
    level: z.enum(["log", "warn", "error", "all"]).default("all"),
    filter: z.string().optional(),
    limit: z.number().default(50),
    offset: z.number().default(0),
    since: z.number().optional(),
    clear: z.boolean().default(false),
  },
  async ({ level, filter, limit, offset, since, clear }) => {
    const pg = await ensurePage();
    try {
      let logs = [];

      try {
        const bridgeLogs = await pg.evaluate(
          (opts) => window.__fb.getConsoleLogs(opts),
          { since, limit: 0, offset: 0, level: level === "all" ? undefined : level, filter }
        );
        if (Array.isArray(bridgeLogs)) logs = bridgeLogs;
      } catch {
        const allLogs = await pg.evaluate(() => window.__fb ? window.__fb.getConsoleLogs() : []) || [];
        logs = allLogs;
      }

      if (level === "error" || level === "all") {
        try {
          const errors = await pg.evaluate(() => window.__fb ? window.__fb.getErrors() : []) || [];
          logs = logs.concat(errors.map((e) => ({ level: "error", message: e.message || String(e), timestamp: e.timestamp || 0, source: e.type, ...e })));
        } catch {}
      }

      if (level !== "all") logs = logs.filter((l) => l.level === level);
      if (since) logs = logs.filter((l) => (l.timestamp || 0) >= since);
      if (filter) {
        try {
          const regex = new RegExp(filter, "i");
          logs = logs.filter((l) => regex.test(l.message || ""));
        } catch {
          const lf = filter.toLowerCase();
          logs = logs.filter((l) => (l.message || "").toLowerCase().includes(lf));
        }
      }

      logs = logs.map((l) => ({ ...l, message: stripCSSFormatting(l.message || "") }));
      logs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      const total = logs.length;
      logs = logs.slice(offset, offset + limit);
      const hasMore = (offset + limit) < total;

      if (clear) {
        await pg.evaluate(() => { if (window.__fb) { window.__fb.clearConsoleLogs(); window.__fb.clearErrors(); } });
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, logs, total, returned: logs.length, hasMore }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: errors ----
server.tool(
  "errors",
  "Return uncaught exceptions from the page",
  {
    clear: z.boolean().default(false),
  },
  async ({ clear }) => {
    const pg = await ensurePage();
    try {
      const errors = await pg.evaluate(() => window.__fb ? window.__fb.getErrors() : []) || [];
      if (clear) {
        await pg.evaluate(() => { if (window.__fb) window.__fb.clearErrors(); });
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ errors, count: errors.length }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: websocket_log ----
server.tool(
  "websocket_log",
  "Return WebSocket messages",
  {
    urlFilter: z.string().optional(),
    direction: z.enum(["send", "receive", "all"]).default("all"),
    limit: z.number().default(50),
    clear: z.boolean().default(false),
  },
  async ({ urlFilter, direction, limit, clear }) => {
    const pg = await ensurePage();
    try {
      if (!wsLogStarted) {
        await pg.evaluate(() => window.__fb.startWsLog());
        wsLogStarted = true;
      }

      let messages = await pg.evaluate(() => window.__fb.getWsLog()) || [];

      if (urlFilter) messages = messages.filter((m) => m.url && m.url.includes(urlFilter));
      if (direction !== "all") messages = messages.filter((m) => m.direction === direction);
      messages = messages.slice(-limit);

      if (clear) {
        await pg.evaluate(() => window.__fb.clearWsLog());
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ messages, count: messages.length }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: perf_metrics (enhanced) ----
server.tool(
  "perf_metrics",
  "Get Core Web Vitals and comprehensive performance metrics (TTFB, FCP, LCP, CLS, long tasks, memory)",
  {},
  async () => {
    const pg = await ensurePage();
    try {
      const metrics = await pg.evaluate(() => {
        if (window.__fb && typeof window.__fb.getEnhancedPerfMetrics === "function") {
          return window.__fb.getEnhancedPerfMetrics();
        }
        const result = {
          navigation: { ttfb: null, fcp: null, lcp: null, cls: null, domInteractive: null, domComplete: null },
          longTasks: { count: 0, totalMs: 0, entries: [] },
          memory: { usedMB: null, totalMB: null, limitMB: null },
          domNodes: document.querySelectorAll("*").length,
          url: location.href,
          title: document.title,
        };
        try {
          const nav = performance.getEntriesByType("navigation")[0];
          if (nav) {
            result.navigation.ttfb = Math.round(nav.responseStart - nav.requestStart);
            result.navigation.domInteractive = Math.round(nav.domInteractive);
            result.navigation.domComplete = Math.round(nav.domComplete);
          }
        } catch {}
        try {
          const fcp = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
          if (fcp) result.navigation.fcp = Math.round(fcp.startTime);
        } catch {}
        try {
          const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
          if (lcpEntries.length) result.navigation.lcp = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
        } catch {}
        try {
          const ls = performance.getEntriesByType("layout-shift");
          if (ls.length) {
            let cls = 0;
            for (const e of ls) { if (!e.hadRecentInput) cls += e.value; }
            result.navigation.cls = Math.round(cls * 1000) / 1000;
          }
        } catch {}
        try {
          const lt = performance.getEntriesByType("longtask");
          result.longTasks.count = lt.length;
          result.longTasks.totalMs = Math.round(lt.reduce((s, t) => s + t.duration, 0));
          result.longTasks.entries = lt.slice(-10).map((t) => ({ startTime: Math.round(t.startTime), duration: Math.round(t.duration) }));
        } catch {}
        if (performance.memory) {
          result.memory.usedMB = Math.round(performance.memory.usedJSHeapSize / 1048576 * 100) / 100;
          result.memory.totalMB = Math.round(performance.memory.totalJSHeapSize / 1048576 * 100) / 100;
          result.memory.limitMB = Math.round(performance.memory.jsHeapSizeLimit / 1048576 * 100) / 100;
        }
        return result;
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...metrics }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: perf_trace ----
server.tool(
  "perf_trace",
  "Start/stop a lightweight performance trace for a specific interaction",
  {
    action: z.enum(["start", "stop"]),
    name: z.string().optional(),
  },
  async ({ action, name }) => {
    const pg = await ensurePage();
    try {
      if (action === "start") {
        await pg.evaluate(() => {
          if (window.__fb) {
            window.__fb.startPerf();
            window.__fb.startNetworkLog();
            window.__fb.clearErrors();
            window.__fb.clearConsoleLogs();
          }
        });
        networkLogStarted = true;
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, action: "start", name: name || "trace", startedAt: Date.now() }) }],
        };
      } else {
        const report = await pg.evaluate(() => {
          const result = {};
          if (window.__fb) {
            result.perf = window.__fb.stopPerf();
            result.networkRequests = window.__fb.getNetworkLog();
            result.errors = window.__fb.getErrors();
            result.consoleLogs = window.__fb.getConsoleLogs();
          }
          return result;
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              name: name || "trace",
              perf: report.perf || {},
              networkRequests: report.networkRequests || [],
              errors: report.errors || [],
              consoleLogs: report.consoleLogs || [],
            }, null, 2),
          }],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: form_fill ----
server.tool(
  "form_fill",
  "Fill an entire form by field labels",
  {
    formSelector: z.string().default("form"),
    fields: z.record(z.string()),
  },
  async ({ formSelector, fields }) => {
    const pg = await ensurePage();
    try {
      const formFields = await pg.evaluate(
        (sel) => window.__fb.getFormFields(sel),
        formSelector
      );

      const filledFields = [];
      const missingFields = [];

      for (const [label, value] of Object.entries(fields)) {
        const match = formFields.find(
          (f) => f.label && f.label.toLowerCase().includes(label.toLowerCase())
        ) || formFields.find(
          (f) => f.name && f.name.toLowerCase().includes(label.toLowerCase())
        ) || formFields.find(
          (f) => f.placeholder && f.placeholder.toLowerCase().includes(label.toLowerCase())
        );

        if (!match) {
          missingFields.push(label);
          continue;
        }

        if (match.type === "select" || match.tagName === "SELECT") {
          await pg.select(match.selector, value);
        } else if (match.type === "checkbox" || match.type === "radio") {
          const isChecked = await pg.evaluate(
            (s) => document.querySelector(s)?.checked,
            match.selector
          );
          const wantChecked = value === "true" || value === "1";
          if (isChecked !== wantChecked) await pg.click(match.selector);
        } else {
          await pg.click(match.selector, { clickCount: 3 });
          await pg.keyboard.type(value);
        }

        filledFields.push(label);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: missingFields.length === 0,
            filledFields,
            missingFields,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: accessibility_audit ----
server.tool(
  "accessibility_audit",
  "Run accessibility checks using axe-core",
  {
    selector: z.string().default("body"),
    rules: z.array(z.string()).optional(),
  },
  async ({ selector, rules }) => {
    const pg = await ensurePage();
    try {
      // Inject axe-core from CDN if not already loaded
      await pg.evaluate(async () => {
        if (!window.axe) {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js";
          document.head.appendChild(s);
          await new Promise((resolve, reject) => {
            s.onload = resolve;
            s.onerror = () => reject(new Error("Failed to load axe-core"));
          });
        }
      });

      const results = await pg.evaluate(
        (sel, r) => {
          const opts = r ? { runOnly: r } : {};
          return axe.run(sel, opts);
        },
        selector,
        rules || null
      );

      const output = {
        violations: (results.violations || []).map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          nodes: (v.nodes || []).map((n) => ({
            target: n.target,
            html: n.html,
            failureSummary: n.failureSummary,
          })),
        })),
        passes: results.passes ? results.passes.length : 0,
        incomplete: results.incomplete ? results.incomplete.length : 0,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: storage ----
server.tool(
  "storage",
  "Read/write localStorage, sessionStorage, or cookies",
  {
    action: z.enum(["get", "set", "delete", "clear"]),
    store: z.enum(["localStorage", "sessionStorage", "cookies"]),
    key: z.string().optional(),
    value: z.string().optional(),
  },
  async ({ action, store, key, value }) => {
    const pg = await ensurePage();
    try {
      if (store === "cookies") {
        switch (action) {
          case "get": {
            const cookies = await pg.cookies();
            if (key) {
              const cookie = cookies.find((c) => c.name === key);
              return { content: [{ type: "text", text: JSON.stringify({ ok: true, value: cookie || null }) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, cookies }, null, 2) }] };
          }
          case "set": {
            if (!key) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "key required" }) }] };
            await pg.setCookie({ name: key, value: value || "", url: pg.url() });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, key, value }) }] };
          }
          case "delete": {
            if (!key) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "key required" }) }] };
            await pg.deleteCookie({ name: key });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: key }) }] };
          }
          case "clear": {
            const all = await pg.cookies();
            if (all.length) await pg.deleteCookie(...all);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, cleared: all.length }) }] };
          }
        }
      } else {
        // localStorage or sessionStorage
        switch (action) {
          case "get": {
            const data = await pg.evaluate((s, k) => {
              const storage = s === "localStorage" ? localStorage : sessionStorage;
              if (k) return storage.getItem(k);
              const obj = {};
              for (let i = 0; i < storage.length; i++) {
                const sk = storage.key(i);
                obj[sk] = storage.getItem(sk);
              }
              return obj;
            }, store, key || null);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, [key ? "value" : "entries"]: data }, null, 2) }] };
          }
          case "set": {
            if (!key) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "key required" }) }] };
            await pg.evaluate((s, k, v) => {
              const storage = s === "localStorage" ? localStorage : sessionStorage;
              storage.setItem(k, v);
            }, store, key, value || "");
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, key, value }) }] };
          }
          case "delete": {
            if (!key) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "key required" }) }] };
            await pg.evaluate((s, k) => {
              const storage = s === "localStorage" ? localStorage : sessionStorage;
              storage.removeItem(k);
            }, store, key);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: key }) }] };
          }
          case "clear": {
            await pg.evaluate((s) => {
              const storage = s === "localStorage" ? localStorage : sessionStorage;
              storage.clear();
            }, store);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, cleared: store }) }] };
          }
        }
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: responsive ----
server.tool(
  "responsive",
  "Resize viewport to a preset or custom size and return layout state",
  {
    preset: z.enum(["mobile", "tablet", "desktop", "wide"]).optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  },
  async ({ preset, width, height }) => {
    const pg = await ensurePage();
    try {
      const presets = {
        mobile: { width: 375, height: 667 },
        tablet: { width: 768, height: 1024 },
        desktop: { width: 1280, height: 800 },
        wide: { width: 1920, height: 1080 },
      };

      let vp;
      if (preset) {
        vp = presets[preset];
      } else if (width && height) {
        vp = { width, height };
      } else {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "Provide a preset or width+height" }) }],
        };
      }

      await pg.setViewport(vp);
      // Wait a tick for reflow
      await new Promise((r) => setTimeout(r, 100));

      const snapshot = await pg.evaluate(
        (sel, opts) => window.__fb.domSnapshot(sel, opts),
        "body",
        { maxDepth: 3, maxChildren: 50, visibleOnly: true }
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            viewport: vp,
            domSnapshot: snapshot,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: wait_for ----
server.tool(
  "wait_for",
  "Wait for a condition to be met (selector, text, URL, network request, or console message)",
  {
    selector: z.string().optional(),
    text: z.string().optional(),
    url: z.string().optional(),
    network: z.string().optional(),
    console: z.string().optional(),
    timeout: z.number().default(5000),
    visible: z.boolean().default(true),
  },
  async ({ selector, text, url, network, console: consoleTxt, timeout, visible }) => {
    const pg = await ensurePage();
    const t0 = Date.now();
    try {
      if (selector) {
        if (visible) {
          await pg.waitForSelector(selector, { visible: true, timeout });
        } else {
          await pg.waitForSelector(selector, { hidden: true, timeout });
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              waitedMs: Date.now() - t0,
              matched: `selector: ${selector}`,
            }),
          }],
        };
      }

      if (text) {
        await pg.waitForFunction(
          (t) => document.body.innerText.includes(t),
          { timeout },
          text
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              waitedMs: Date.now() - t0,
              matched: `text: ${text}`,
            }),
          }],
        };
      }

      if (url) {
        await pg.waitForFunction(
          (u) => location.href.includes(u),
          { timeout },
          url
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              waitedMs: Date.now() - t0,
              matched: `url contains: ${url}`,
            }),
          }],
        };
      }

      if (network) {
        if (!networkLogStarted) {
          await pg.evaluate(() => window.__fb.startNetworkLog());
          networkLogStarted = true;
        }
        await pg.waitForFunction(
          (pattern) => {
            const log = window.__fb.getNetworkLog();
            return log.some((r) => r.url && r.url.includes(pattern));
          },
          { timeout },
          network
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              waitedMs: Date.now() - t0,
              matched: `network request: ${network}`,
            }),
          }],
        };
      }

      if (consoleTxt) {
        await pg.waitForFunction(
          (pattern) => {
            const logs = window.__fb.getConsoleLogs();
            return logs.some((l) => l.message && l.message.includes(pattern));
          },
          { timeout },
          consoleTxt
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              waitedMs: Date.now() - t0,
              matched: `console message: ${consoleTxt}`,
            }),
          }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "No condition specified" }) }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            waitedMs: Date.now() - t0,
            reason: err.message,
          }),
        }],
      };
    }
  }
);


// ===========================================================================
// New tool additions: CSS, React, Visual, Perf, Bundle, Network, Audits
// ===========================================================================

// ---- Tool: css_audit ----
server.tool(
  "css_audit",
  "Computed style analysis for any selector, with optional diff against a second selector",
  {
    selector: z.string(),
    diff: z.string().optional(),
  },
  async ({ selector, diff }) => {
    const pg = await ensurePage();
    try {
      const result = await pg.evaluate(
        (sel) => window.__fb.cssAudit(sel),
        selector
      );

      if (diff) {
        const diffResult = await pg.evaluate(
          (a, b) => window.__fb.cssDiff(a, b),
          selector,
          diff
        );
        result.diff = diffResult;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: css_coverage ----
server.tool(
  "css_coverage",
  "CSS coverage analysis using Chrome DevTools Protocol",
  {},
  async () => {
    const pg = await ensurePage();
    try {
      const client = await pg.createCDPSession();
      await client.send("CSS.enable");
      await client.send("CSS.startRuleUsageTracking");
      // Brief pause to let the page settle
      await new Promise((r) => setTimeout(r, 100));
      const { ruleUsage } = await client.send("CSS.stopRuleUsageTracking");
      await client.send("CSS.disable");
      await client.detach();

      const totalRules = ruleUsage.length;
      const usedRules = ruleUsage.filter((r) => r.used).length;
      const coveragePct = totalRules > 0 ? Math.round((usedRules / totalRules) * 100) : 0;

      // Group by stylesheet URL
      const bySheet = {};
      for (const rule of ruleUsage) {
        const url = rule.styleSheetId || "(inline)";
        if (!bySheet[url]) {
          bySheet[url] = { url, total: 0, used: 0, unusedBytes: 0 };
        }
        bySheet[url].total++;
        if (rule.used) {
          bySheet[url].used++;
        } else {
          bySheet[url].unusedBytes += (rule.endOffset - rule.startOffset);
        }
      }

      const byStylesheet = Object.values(bySheet).map((s) => ({
        ...s,
        coverage: s.total > 0 ? Math.round((s.used / s.total) * 100) + "%" : "0%",
      }));

      // Top unused rule selectors (first 20)
      const topUnused = ruleUsage
        .filter((r) => !r.used)
        .slice(0, 20)
        .map((r) => ({
          styleSheetId: r.styleSheetId,
          startOffset: r.startOffset,
          endOffset: r.endOffset,
        }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            totalRules,
            usedRules,
            coverage: coveragePct + "%",
            byStylesheet,
            topUnused,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: computed_layout ----
server.tool(
  "computed_layout",
  "Full box model and geometry for an element",
  {
    selector: z.string(),
  },
  async ({ selector }) => {
    const pg = await ensurePage();
    try {
      const layout = await pg.evaluate(
        (sel) => window.__fb.computedLayout(sel),
        selector
      );
      return {
        content: [{ type: "text", text: JSON.stringify(layout, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: react_tree ----
server.tool(
  "react_tree",
  "React component tree with props, state, and hooks",
  {
    selector: z.string().default("body"),
    maxDepth: z.number().default(6),
    propsMaxLength: z.number().default(500),
  },
  async ({ selector, maxDepth, propsMaxLength }) => {
    const pg = await ensurePage();
    try {
      const tree = await pg.evaluate(
        (sel, depth) => window.__fb.getReactTree(sel, depth),
        selector,
        maxDepth
      );

      if (!tree) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "React fiber not found. Is this a React app?" }) }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(tree, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: react_profiler ----
server.tool(
  "react_profiler",
  "Start/stop React profiler recording",
  {
    action: z.enum(["start", "stop"]),
  },
  async ({ action }) => {
    const pg = await ensurePage();
    try {
      if (action === "start") {
        const result = await pg.evaluate(() => window.__fb.startReactProfiler());
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, action: "start", ...result }, null, 2) }],
        };
      } else {
        const result = await pg.evaluate(() => window.__fb.stopReactProfiler());
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, action: "stop", ...result }, null, 2) }],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: screenshot_diff ----
server.tool(
  "screenshot_diff",
  "Visual regression comparison: capture baselines and compare against them",
  {
    action: z.enum(["baseline", "compare"]),
    name: z.string(),
    selector: z.string().optional(),
    threshold: z.number().default(0.1),
  },
  async ({ action, name, selector, threshold }) => {
    const pg = await ensurePage();
    try {
      // Take screenshot (element or full page)
      let screenshotBuffer;
      if (selector) {
        const el = await pg.$(selector);
        if (!el) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, reason: `Element "${selector}" not found` }) }],
          };
        }
        screenshotBuffer = await el.screenshot();
      } else {
        screenshotBuffer = await pg.screenshot();
      }

      if (action === "baseline") {
        baselines.set(name, screenshotBuffer);
        const baselinePath = path.join(CFG.outputDir, `${name}-baseline.png`);
        fs.writeFileSync(baselinePath, screenshotBuffer);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              action: "baseline",
              name,
              path: baselinePath,
              sizeBytes: screenshotBuffer.length,
            }, null, 2),
          }],
        };
      } else {
        // compare
        const baselineBuffer = baselines.get(name);
        if (!baselineBuffer) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, reason: `No baseline found for "${name}". Capture a baseline first.` }) }],
          };
        }

        const currentPath = path.join(CFG.outputDir, `${name}-current.png`);
        fs.writeFileSync(currentPath, screenshotBuffer);

        const baselinePath = path.join(CFG.outputDir, `${name}-baseline.png`);
        const diffPath = path.join(CFG.outputDir, `${name}-diff.png`);

        // Use canvas-based pixel comparison in the browser
        const baselineB64 = baselineBuffer.toString("base64");
        const currentB64 = screenshotBuffer.toString("base64");

        const diffResult = await pg.evaluate(async (baseB64, currB64, thresh) => {
          function loadImage(b64) {
            return new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = reject;
              img.src = "data:image/png;base64," + b64;
            });
          }

          const [baseImg, currImg] = await Promise.all([
            loadImage(baseB64),
            loadImage(currB64),
          ]);

          const w = Math.max(baseImg.width, currImg.width);
          const h = Math.max(baseImg.height, currImg.height);

          const baseCanvas = document.createElement("canvas");
          baseCanvas.width = w;
          baseCanvas.height = h;
          const baseCtx = baseCanvas.getContext("2d");
          baseCtx.drawImage(baseImg, 0, 0);
          const baseData = baseCtx.getImageData(0, 0, w, h).data;

          const currCanvas = document.createElement("canvas");
          currCanvas.width = w;
          currCanvas.height = h;
          const currCtx = currCanvas.getContext("2d");
          currCtx.drawImage(currImg, 0, 0);
          const currData = currCtx.getImageData(0, 0, w, h).data;

          const diffCanvas = document.createElement("canvas");
          diffCanvas.width = w;
          diffCanvas.height = h;
          const diffCtx = diffCanvas.getContext("2d");
          const diffImgData = diffCtx.createImageData(w, h);

          let diffPixels = 0;
          const totalPixels = w * h;
          const pixelThreshold = Math.round(thresh * 255);

          for (let i = 0; i < baseData.length; i += 4) {
            const rDiff = Math.abs(baseData[i] - currData[i]);
            const gDiff = Math.abs(baseData[i + 1] - currData[i + 1]);
            const bDiff = Math.abs(baseData[i + 2] - currData[i + 2]);

            if (rDiff > pixelThreshold || gDiff > pixelThreshold || bDiff > pixelThreshold) {
              diffPixels++;
              // Highlight diff pixel in red
              diffImgData.data[i] = 255;
              diffImgData.data[i + 1] = 0;
              diffImgData.data[i + 2] = 0;
              diffImgData.data[i + 3] = 255;
            } else {
              // Dimmed original pixel
              diffImgData.data[i] = currData[i] * 0.3;
              diffImgData.data[i + 1] = currData[i + 1] * 0.3;
              diffImgData.data[i + 2] = currData[i + 2] * 0.3;
              diffImgData.data[i + 3] = 255;
            }
          }

          diffCtx.putImageData(diffImgData, 0, 0);
          const diffDataUrl = diffCanvas.toDataURL("image/png");
          const diffB64 = diffDataUrl.split(",")[1];

          const diffPercent = totalPixels > 0
            ? Math.round((diffPixels / totalPixels) * 10000) / 100
            : 0;

          return { diffPercent, diffPixels, totalPixels, diffB64 };
        }, baselineB64, currentB64, threshold);

        // Save diff image
        if (diffResult.diffB64) {
          const diffBuffer = Buffer.from(diffResult.diffB64, "base64");
          fs.writeFileSync(diffPath, diffBuffer);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              diffPercent: diffResult.diffPercent,
              diffPixels: diffResult.diffPixels,
              totalPixels: diffResult.totalPixels,
              baselinePath,
              currentPath,
              diffPath,
            }, null, 2),
          }],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: perf_flamechart ----
server.tool(
  "perf_flamechart",
  "CPU profile for an interaction using Chrome DevTools Protocol",
  {
    action: z.enum(["start", "stop"]),
    duration: z.number().optional(),
  },
  async ({ action, duration }) => {
    const pg = await ensurePage();
    try {
      if (action === "start") {
        const client = await pg.createCDPSession();
        await client.send("Profiler.enable");
        await client.send("Profiler.start");
        profilerSession = client;

        if (duration) {
          // Auto-stop after duration ms
          await new Promise((r) => setTimeout(r, duration));
          return await stopProfiler();
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, action: "start", message: "CPU profiling started. Call with action='stop' to collect results." }) }],
        };
      } else {
        // stop
        if (!profilerSession) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "No profiler session active. Call with action='start' first." }) }],
          };
        }
        return await stopProfiler();
      }
    } catch (err) {
      // Clean up CDP session on error
      if (profilerSession) {
        try {
          await profilerSession.send("Profiler.disable");
          await profilerSession.detach();
        } catch {}
        profilerSession = null;
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

async function stopProfiler() {
  let client = profilerSession;
  try {
    const { profile } = await client.send("Profiler.stop");
    await client.send("Profiler.disable");
    await client.detach();
    profilerSession = null;

    // Build node map and calculate self-time
    const nodeMap = new Map();
    for (const node of profile.nodes) {
      nodeMap.set(node.id, {
        id: node.id,
        functionName: node.callFrame.functionName || "(anonymous)",
        url: node.callFrame.url || "",
        lineNumber: node.callFrame.lineNumber,
        hitCount: node.hitCount || 0,
        children: node.children || [],
        selfTime: 0,
        totalTime: 0,
      });
    }

    // Calculate time per sample (microseconds)
    const samples = profile.samples || [];
    const timeDeltas = profile.timeDeltas || [];

    // Accumulate self-time from samples
    for (let i = 0; i < samples.length; i++) {
      const nodeId = samples[i];
      const delta = i < timeDeltas.length ? timeDeltas[i] : 0;
      const node = nodeMap.get(nodeId);
      if (node) {
        node.selfTime += delta;
      }
    }

    // Calculate total time via DFS (self + children)
    function calcTotalTime(nodeId) {
      const node = nodeMap.get(nodeId);
      if (!node) return 0;
      let total = node.selfTime;
      for (const childId of node.children) {
        total += calcTotalTime(childId);
      }
      node.totalTime = total;
      return total;
    }

    // Find root nodes (nodes that are not children of any other node)
    const childSet = new Set();
    for (const node of profile.nodes) {
      for (const childId of (node.children || [])) {
        childSet.add(childId);
      }
    }
    for (const node of profile.nodes) {
      if (!childSet.has(node.id)) {
        calcTotalTime(node.id);
      }
    }

    // Sort by self-time descending, take top 30
    const allNodes = [...nodeMap.values()];
    allNodes.sort((a, b) => b.selfTime - a.selfTime);
    const hotFunctions = allNodes
      .filter((n) => n.selfTime > 0)
      .slice(0, 30)
      .map((n) => ({
        name: n.functionName,
        url: n.url,
        line: n.lineNumber,
        selfTime: n.selfTime,
        totalTime: n.totalTime,
        hits: n.hitCount,
      }));

    // Build heaviest stacks: find leaf nodes with highest cumulative selfTime,
    // walk up to root via parent links
    const parentMap = new Map();
    for (const node of profile.nodes) {
      for (const childId of (node.children || [])) {
        parentMap.set(childId, node.id);
      }
    }

    // Get leaf nodes (nodes with no children or nodes that appear in samples)
    // Use sample frequency to rank stacks
    const stackWeights = new Map();
    for (let i = 0; i < samples.length; i++) {
      const nodeId = samples[i];
      const delta = i < timeDeltas.length ? timeDeltas[i] : 0;
      // Build stack trace from this sample
      const stack = [];
      let current = nodeId;
      while (current !== undefined) {
        const node = nodeMap.get(current);
        if (node) {
          stack.unshift(node.functionName);
        }
        current = parentMap.get(current);
      }
      const stackKey = stack.join(" > ");
      stackWeights.set(stackKey, (stackWeights.get(stackKey) || 0) + delta);
    }

    // Sort stacks by cumulative time, take top 5
    const heaviestStacks = [...stackWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([stack, time]) => ({
        stack: stack.split(" > "),
        cumulativeTime: time,
      }));

    const durationUs = (profile.endTime || 0) - (profile.startTime || 0);

    const result = {
      ok: true,
      duration: durationUs,
      totalSamples: samples.length,
      hotFunctions,
      heaviestStacks,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    try {
      await client.send("Profiler.disable");
      await client.detach();
    } catch {}
    profilerSession = null;
    throw err;
  }
}

// ---- Tool: perf_memory_snapshot ----
server.tool(
  "perf_memory_snapshot",
  "Heap analysis using Chrome DevTools Protocol — take snapshots and diff them",
  {
    action: z.enum(["snapshot", "diff"]),
    name: z.string().optional(),
  },
  async ({ action, name }) => {
    const pg = await ensurePage();
    let client = null;
    try {
      client = await pg.createCDPSession();
      await client.send("HeapProfiler.enable");

      // Collect heap stats from page
      const stats = await pg.evaluate(() => ({
        heapUsed: performance.memory ? performance.memory.usedJSHeapSize : null,
        heapTotal: performance.memory ? performance.memory.totalJSHeapSize : null,
        heapLimit: performance.memory ? performance.memory.jsHeapSizeLimit : null,
        domNodes: document.querySelectorAll("*").length,
      }));

      // Force GC before sampling for cleaner data
      await client.send("HeapProfiler.collectGarbage");

      // Take a sampling profile for allocation data
      await client.send("HeapProfiler.startSampling", { samplingInterval: 16384 });
      await new Promise((r) => setTimeout(r, 200));
      const sampling = await client.send("HeapProfiler.stopSampling");

      await client.send("HeapProfiler.disable");
      await client.detach();
      client = null;

      // Process sampling data — group allocations by function/constructor name
      const allocMap = new Map();
      function walkSamplingNodes(node) {
        const name = node.callFrame.functionName || "(anonymous)";
        if (node.selfSize > 0) {
          const existing = allocMap.get(name) || { constructor: name, count: 0, sizeBytes: 0 };
          existing.count += 1;
          existing.sizeBytes += node.selfSize;
          allocMap.set(name, existing);
        }
        for (const child of (node.children || [])) {
          walkSamplingNodes(child);
        }
      }

      if (sampling.profile && sampling.profile.head) {
        walkSamplingNodes(sampling.profile.head);
      }

      const topAllocations = [...allocMap.values()]
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, 20);

      const heap = {
        usedMB: stats.heapUsed ? Math.round(stats.heapUsed / 1024 / 1024 * 100) / 100 : null,
        totalMB: stats.heapTotal ? Math.round(stats.heapTotal / 1024 / 1024 * 100) / 100 : null,
        limitMB: stats.heapLimit ? Math.round(stats.heapLimit / 1024 / 1024 * 100) / 100 : null,
      };

      const snapshotData = {
        heap,
        domNodes: stats.domNodes,
        topAllocations,
        timestamp: Date.now(),
      };

      let diff = null;

      if (action === "snapshot" && name) {
        // Save for later diff
        heapSnapshots.set(name, snapshotData);
      } else if (action === "diff") {
        const baselineName = name || "default";
        const baseline = heapSnapshots.get(baselineName);
        if (baseline) {
          diff = {
            heapDelta: {
              usedMB: heap.usedMB != null && baseline.heap.usedMB != null
                ? Math.round((heap.usedMB - baseline.heap.usedMB) * 100) / 100
                : null,
              totalMB: heap.totalMB != null && baseline.heap.totalMB != null
                ? Math.round((heap.totalMB - baseline.heap.totalMB) * 100) / 100
                : null,
            },
            domNodesDelta: stats.domNodes - baseline.domNodes,
            timeDeltaMs: Date.now() - baseline.timestamp,
            newAllocations: topAllocations.filter((a) => {
              const baselineAlloc = baseline.topAllocations.find((b) => b.constructor === a.constructor);
              return !baselineAlloc || a.sizeBytes > baselineAlloc.sizeBytes;
            }),
          };
        } else {
          diff = { error: `No baseline found with name "${baselineName}". Take a snapshot first with action='snapshot' and name='${baselineName}'.` };
        }
      }

      const result = {
        ok: true,
        heap,
        domNodes: stats.domNodes,
        topAllocations,
        savedAs: action === "snapshot" && name ? name : undefined,
        diff,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (client) {
        try {
          await client.send("HeapProfiler.disable");
          await client.detach();
        } catch {}
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: perf_resource_timing ----
server.tool(
  "perf_resource_timing",
  "All resource loads with timing breakdown",
  {
    type: z.enum(["all", "script", "css", "img", "font", "fetch", "xhr"]).default("all"),
    sort: z.enum(["duration", "size", "startTime"]).default("startTime"),
  },
  async ({ type, sort }) => {
    const pg = await ensurePage();
    try {
      // Try bridge first, fall back to direct evaluate
      let resources = await pg.evaluate((filterType) => {
        if (window.__fb && typeof window.__fb.getResourceTiming === "function") {
          return window.__fb.getResourceTiming();
        }
        // Fallback: collect directly
        return performance.getEntriesByType("resource").map((r) => ({
          name: r.name,
          initiatorType: r.initiatorType,
          startTime: Math.round(r.startTime),
          duration: Math.round(r.duration),
          transferSize: r.transferSize,
          decodedBodySize: r.decodedBodySize,
          encodedBodySize: r.encodedBodySize,
          // Timing breakdown
          dns: Math.round(r.domainLookupEnd - r.domainLookupStart),
          tcp: Math.round(r.connectEnd - r.connectStart),
          ssl: r.secureConnectionStart > 0 ? Math.round(r.connectEnd - r.secureConnectionStart) : 0,
          ttfb: Math.round(r.responseStart - r.requestStart),
          download: Math.round(r.responseEnd - r.responseStart),
          blocked: Math.round(r.requestStart - r.startTime),
          cached: r.transferSize === 0 && r.decodedBodySize > 0,
          renderBlocking: r.renderBlockingStatus === "blocking",
        }));
      }, type);

      // Filter by type
      if (type !== "all") {
        const typeMap = {
          script: "script",
          css: "link",
          img: "img",
          font: "css", // fonts are often initiated by CSS
          fetch: "fetch",
          xhr: "xmlhttprequest",
        };
        const initiator = typeMap[type];
        resources = resources.filter((r) => {
          if (type === "css") {
            return r.initiatorType === "link" && (r.name.endsWith(".css") || r.name.includes(".css?"));
          }
          if (type === "font") {
            return r.initiatorType === "css" && /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(r.name);
          }
          return r.initiatorType === initiator;
        });
      }

      // Sort
      const sortFn = {
        duration: (a, b) => b.duration - a.duration,
        size: (a, b) => (b.transferSize || 0) - (a.transferSize || 0),
        startTime: (a, b) => a.startTime - b.startTime,
      };
      resources.sort(sortFn[sort]);

      // Build summary
      const byType = {};
      let totalSize = 0;
      let totalDuration = 0;
      let cached = 0;
      let renderBlocking = 0;
      let slowest = null;
      let largest = null;

      for (const r of resources) {
        const t = r.initiatorType || "other";
        if (!byType[t]) byType[t] = { count: 0, sizeKB: 0 };
        byType[t].count++;
        const sizeKB = Math.round((r.transferSize || 0) / 1024 * 100) / 100;
        byType[t].sizeKB = Math.round((byType[t].sizeKB + sizeKB) * 100) / 100;
        totalSize += r.transferSize || 0;
        totalDuration += r.duration || 0;
        if (r.cached) cached++;
        if (r.renderBlocking) renderBlocking++;
        if (!slowest || r.duration > slowest.duration) {
          slowest = { name: r.name, duration: r.duration };
        }
        if (!largest || (r.transferSize || 0) > (largest.transferSize || 0)) {
          largest = { name: r.name, sizeKB: Math.round((r.transferSize || 0) / 1024 * 100) / 100 };
        }
      }

      const summary = {
        total: resources.length,
        totalSizeKB: Math.round(totalSize / 1024 * 100) / 100,
        byType,
        avgDuration: resources.length ? Math.round(totalDuration / resources.length) : 0,
        slowest,
        largest,
        cached,
        renderBlocking,
      };

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, resources, summary }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: bundle_audit ----
server.tool(
  "bundle_audit",
  "Analyze loaded JS/CSS bundles — sizes, compression, and warnings",
  {},
  async () => {
    const pg = await ensurePage();
    let client = null;
    try {
      // Get script resource timing from the page
      const scripts = await pg.evaluate(() =>
        performance.getEntriesByType("resource")
          .filter((r) => r.initiatorType === "script")
          .map((r) => ({
            url: r.name,
            transferSize: r.transferSize,
            decodedBodySize: r.decodedBodySize,
            encodedBodySize: r.encodedBodySize,
            duration: Math.round(r.duration),
            cached: r.transferSize === 0 && r.decodedBodySize > 0,
          }))
      );

      // Get CSS resource timing
      const cssResources = await pg.evaluate(() =>
        performance.getEntriesByType("resource")
          .filter((r) => r.initiatorType === "link" && (r.name.endsWith(".css") || r.name.includes(".css?")))
          .map((r) => ({
            url: r.name,
            transferSize: r.transferSize,
            decodedBodySize: r.decodedBodySize,
            encodedBodySize: r.encodedBodySize,
            duration: Math.round(r.duration),
            cached: r.transferSize === 0 && r.decodedBodySize > 0,
          }))
      );

      // Get stylesheet info (rule counts, disabled state)
      const styleSheetInfo = await pg.evaluate(() =>
        Array.from(document.styleSheets).map((s) => ({
          href: s.href,
          rules: (() => {
            try { return s.cssRules.length; } catch (e) { return -1; }
          })(),
          disabled: s.disabled,
        }))
      );

      // Get all resource timing for page weight calculation
      const allResources = await pg.evaluate(() =>
        performance.getEntriesByType("resource").map((r) => ({
          initiatorType: r.initiatorType,
          transferSize: r.transferSize,
          decodedBodySize: r.decodedBodySize,
        }))
      );

      // Process scripts
      const scriptEntries = scripts.map((s) => {
        const transferSizeKB = Math.round((s.transferSize || 0) / 1024 * 100) / 100;
        const decodedSizeKB = Math.round((s.decodedBodySize || 0) / 1024 * 100) / 100;
        const compressionRatio = s.decodedBodySize && s.transferSize
          ? Math.round((1 - s.transferSize / s.decodedBodySize) * 100)
          : 0;
        return {
          url: s.url,
          transferSizeKB,
          decodedSizeKB,
          compressionRatio: `${compressionRatio}%`,
          loadDuration: s.duration,
          cached: s.cached,
        };
      });

      // Process stylesheets — merge resource timing with stylesheet info
      const stylesheetEntries = styleSheetInfo.map((si) => {
        const cssRes = cssResources.find((cr) => si.href && cr.url === si.href);
        return {
          url: si.href || "(inline)",
          rules: si.rules,
          transferSizeKB: cssRes ? Math.round((cssRes.transferSize || 0) / 1024 * 100) / 100 : 0,
          decodedSizeKB: cssRes ? Math.round((cssRes.decodedBodySize || 0) / 1024 * 100) / 100 : 0,
          cached: cssRes ? cssRes.cached : false,
          disabled: si.disabled,
        };
      });

      // Totals
      const totalJSSizeKB = Math.round(scripts.reduce((sum, s) => sum + (s.transferSize || 0), 0) / 1024 * 100) / 100;
      const totalCSSSizeKB = Math.round(cssResources.reduce((sum, s) => sum + (s.transferSize || 0), 0) / 1024 * 100) / 100;
      const totalCSSRules = styleSheetInfo.reduce((sum, s) => sum + (s.rules > 0 ? s.rules : 0), 0);

      // Page weight by type
      const byType = {};
      let totalPageWeight = 0;
      for (const r of allResources) {
        const t = r.initiatorType || "other";
        if (!byType[t]) byType[t] = 0;
        byType[t] += r.transferSize || 0;
        totalPageWeight += r.transferSize || 0;
      }
      const byTypeKB = {};
      for (const [k, v] of Object.entries(byType)) {
        byTypeKB[k] = Math.round(v / 1024 * 100) / 100;
      }

      // Generate warnings
      const warnings = [];

      // Large JS bundles (>100KB decoded)
      for (const s of scriptEntries) {
        if (s.decodedSizeKB > 100) {
          const filename = s.url.split("/").pop().split("?")[0];
          warnings.push(`${filename} (${s.decodedSizeKB}KB decoded) — large bundle, consider code splitting`);
        }
      }

      // Total JS > 500KB
      const totalJSDecodedKB = Math.round(scripts.reduce((sum, s) => sum + (s.decodedBodySize || 0), 0) / 1024 * 100) / 100;
      if (totalJSDecodedKB > 500) {
        warnings.push(`Total JS: ${totalJSDecodedKB}KB decoded — exceeds 500KB budget`);
      }

      // Total CSS > 200KB
      const totalCSSDecodedKB = Math.round(cssResources.reduce((sum, s) => sum + (s.decodedBodySize || 0), 0) / 1024 * 100) / 100;
      if (totalCSSDecodedKB > 200) {
        warnings.push(`Total CSS: ${totalCSSDecodedKB}KB decoded — exceeds 200KB budget`);
      }

      // Uncompressed files (transfer ~ decoded when decoded > 10KB)
      for (const s of scripts) {
        const decodedKB = (s.decodedBodySize || 0) / 1024;
        if (decodedKB > 10 && s.transferSize && s.decodedBodySize) {
          const ratio = s.transferSize / s.decodedBodySize;
          if (ratio > 0.9) {
            const filename = s.url.split("/").pop().split("?")[0];
            warnings.push(`${filename} appears uncompressed (transfer/decoded ratio: ${Math.round(ratio * 100)}%) — enable gzip/brotli`);
          }
        }
      }
      for (const s of cssResources) {
        const decodedKB = (s.decodedBodySize || 0) / 1024;
        if (decodedKB > 10 && s.transferSize && s.decodedBodySize) {
          const ratio = s.transferSize / s.decodedBodySize;
          if (ratio > 0.9) {
            const filename = s.url.split("/").pop().split("?")[0];
            warnings.push(`${filename} (CSS) appears uncompressed (transfer/decoded ratio: ${Math.round(ratio * 100)}%) — enable gzip/brotli`);
          }
        }
      }

      const result = {
        ok: true,
        scripts: scriptEntries,
        stylesheets: stylesheetEntries,
        totalJS: { count: scripts.length, sizeKB: totalJSSizeKB, decodedSizeKB: totalJSDecodedKB },
        totalCSS: { count: cssResources.length, sizeKB: totalCSSSizeKB, decodedSizeKB: totalCSSDecodedKB, rules: totalCSSRules },
        totalPageWeight: {
          sizeKB: Math.round(totalPageWeight / 1024 * 100) / 100,
          byType: byTypeKB,
        },
        warnings,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (client) {
        try { await client.detach(); } catch {}
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: network_throttle ----
server.tool(
  "network_throttle",
  "Simulate network conditions (3G, 4G, offline, or custom latency/throughput)",
  {
    preset: z.enum(["3g", "slow-4g", "fast-4g", "offline", "reset"]).optional(),
    latency: z.number().optional(),
    download: z.number().optional(),
    upload: z.number().optional(),
  },
  async ({ preset, latency, download, upload }) => {
    const pg = await ensurePage();
    let client;
    try {
      const presets = {
        "3g": { latency: 400, download: 400 * 1024, upload: 400 * 1024 },
        "slow-4g": { latency: 150, download: 1.5 * 1024 * 1024, upload: 750 * 1024 },
        "fast-4g": { latency: 50, download: 4 * 1024 * 1024, upload: 3 * 1024 * 1024 },
        "offline": { latency: 0, download: 0, upload: 0, offline: true },
        "reset": null,
      };

      client = await pg.createCDPSession();

      let throttleName;
      let settings;

      if (preset === "reset" || (!preset && !latency && !download && !upload)) {
        await client.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        throttleName = "disabled";
        settings = { latency: 0, download: -1, upload: -1 };
      } else {
        const config = preset ? presets[preset] : { latency, download, upload };
        await client.send("Network.emulateNetworkConditions", {
          offline: config.offline || false,
          latency: config.latency || 0,
          downloadThroughput: config.download ?? -1,
          uploadThroughput: config.upload ?? -1,
        });
        throttleName = preset || "custom";
        settings = {
          latency: config.latency || 0,
          download: config.download ?? -1,
          upload: config.upload ?? -1,
          offline: config.offline || false,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, throttle: throttleName, settings }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    } finally {
      if (client) {
        try { await client.detach(); } catch {}
      }
    }
  }
);

// ---- Tool: fonts_audit ----
server.tool(
  "fonts_audit",
  "Analyze font loading: detect FOIT risks, excessive font files, and third-party CDN latency",
  {},
  async () => {
    const pg = await ensurePage();
    try {
      const audit = await pg.evaluate(() => window.__fb.getFontsAudit());

      const warnings = [];

      // Check font-display values
      if (audit.fontFaces && Array.isArray(audit.fontFaces)) {
        for (const ff of audit.fontFaces) {
          const display = (ff.display || ff.fontDisplay || "").toLowerCase();
          if (display !== "swap" && display !== "optional" && display !== "fallback") {
            warnings.push({
              severity: "medium",
              message: `Font "${ff.family || "unknown"}" has font-display: "${display || "auto"}" — risks FOIT (Flash of Invisible Text). Use "swap" or "optional".`,
            });
          }
        }
      }

      // Check number of font files loaded
      if (audit.loaded && Array.isArray(audit.loaded) && audit.loaded.length > 4) {
        warnings.push({
          severity: "medium",
          message: `${audit.loaded.length} font files loaded. Consider reducing to 4 or fewer for better performance.`,
        });
      }

      // Check for third-party CDN fonts
      if (audit.loaded && Array.isArray(audit.loaded)) {
        const currentOrigin = await pg.evaluate(() => location.origin);
        const thirdPartyFonts = audit.loaded.filter((f) => {
          const url = f.url || f.src || "";
          if (!url) return false;
          try {
            const fontOrigin = new URL(url).origin;
            return fontOrigin !== currentOrigin;
          } catch {
            return false;
          }
        });
        if (thirdPartyFonts.length > 0) {
          warnings.push({
            severity: "low",
            message: `${thirdPartyFonts.length} font(s) loaded from third-party CDN — potential latency risk. Consider self-hosting.`,
            urls: thirdPartyFonts.map((f) => f.url || f.src).filter(Boolean),
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            loaded: audit.loaded || [],
            fontFaces: audit.fontFaces || [],
            usedFamilies: audit.usedFamilies || [],
            warnings,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: images_audit ----
server.tool(
  "images_audit",
  "Analyze image optimization: missing alt text, oversized images, lazy loading, and format issues",
  {},
  async () => {
    const pg = await ensurePage();
    try {
      const audit = await pg.evaluate(() => window.__fb.getImagesAudit());
      const images = audit.images || audit || [];

      const warnings = [];
      let missingAlt = 0;
      let oversized = 0;
      let lazyLoadCandidates = 0;
      let totalSizeEstimate = 0;

      const viewportHeight = await pg.evaluate(() => window.innerHeight);

      for (const img of images) {
        const src = img.src || img.url || "";
        const alt = img.alt;
        const naturalW = img.naturalWidth || 0;
        const naturalH = img.naturalHeight || 0;
        const renderedW = img.renderedWidth || img.width || 0;
        const renderedH = img.renderedHeight || img.height || 0;
        const size = img.size || img.fileSize || 0;
        const loading = (img.loading || "").toLowerCase();
        const fetchPriority = (img.fetchpriority || img.fetchPriority || "").toLowerCase();
        const top = img.top || img.offsetTop || 0;

        totalSizeEstimate += size;

        // Missing alt text
        if (alt === null || alt === undefined || alt === "") {
          missingAlt++;
          warnings.push({
            severity: "medium",
            message: `Image missing alt text: ${src.slice(0, 120)}`,
          });
        }

        // Large images (> 200KB)
        if (size > 200 * 1024) {
          oversized++;
          warnings.push({
            severity: "high",
            message: `Image > 200KB (${Math.round(size / 1024)}KB): ${src.slice(0, 120)}`,
          });
        }

        // Rendered much smaller than natural size (>2x beyond retina 2x)
        if (naturalW > 0 && renderedW > 0) {
          const ratio = naturalW / renderedW;
          if (ratio > 2.5) {
            warnings.push({
              severity: "medium",
              message: `Image rendered ${renderedW}x${renderedH} but natural size is ${naturalW}x${naturalH} (${ratio.toFixed(1)}x oversized): ${src.slice(0, 120)}`,
            });
          }
        }

        // Above the fold without eager loading or fetchpriority high
        if (top < viewportHeight && top >= 0) {
          if (loading === "lazy") {
            warnings.push({
              severity: "low",
              message: `Above-fold image has loading="lazy" — consider removing or using "eager": ${src.slice(0, 120)}`,
            });
          }
        }

        // Below the fold without lazy loading
        if (top >= viewportHeight) {
          if (loading !== "lazy") {
            lazyLoadCandidates++;
            warnings.push({
              severity: "low",
              message: `Below-fold image missing loading="lazy": ${src.slice(0, 120)}`,
            });
          }
        }

        // Non-modern format
        const ext = (src.split("?")[0].split(".").pop() || "").toLowerCase();
        if (["jpg", "jpeg", "png", "gif", "bmp"].includes(ext)) {
          warnings.push({
            severity: "low",
            message: `Image could use modern format (WebP/AVIF) instead of .${ext}: ${src.slice(0, 120)}`,
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            images,
            summary: {
              total: images.length,
              totalSizeEstimate,
              missingAlt,
              oversized,
              lazyLoadCandidates,
            },
            warnings,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: seo_audit ----
server.tool(
  "seo_audit",
  "Run basic SEO checks: title, meta description, headings, Open Graph, structured data",
  {},
  async () => {
    const pg = await ensurePage();
    try {
      const seoData = await pg.evaluate(() => window.__fb.getSEOAudit());

      const warnings = [];
      let score = 10;

      // Missing or empty title
      if (!seoData.title || seoData.title.trim() === "") {
        warnings.push({ severity: "high", message: "Missing or empty <title> tag" });
        score -= 2;
      } else if (seoData.title.length > 60) {
        warnings.push({ severity: "low", message: `Title is ${seoData.title.length} chars — ideally under 60` });
        score -= 0.5;
      }

      // Missing meta description
      if (!seoData.metaDescription || seoData.metaDescription.trim() === "") {
        warnings.push({ severity: "high", message: "Missing meta description" });
        score -= 1.5;
      } else if (seoData.metaDescription.length > 160) {
        warnings.push({ severity: "low", message: `Meta description is ${seoData.metaDescription.length} chars — ideally under 160` });
        score -= 0.5;
      }

      // Missing viewport meta
      if (!seoData.viewport) {
        warnings.push({ severity: "high", message: "Missing viewport meta tag" });
        score -= 1;
      }

      // Missing canonical URL
      if (!seoData.canonical) {
        warnings.push({ severity: "medium", message: "Missing canonical URL" });
        score -= 1;
      }

      // Missing og:title or og:image
      if (!seoData.ogTitle) {
        warnings.push({ severity: "medium", message: "Missing og:title meta tag" });
        score -= 0.5;
      }
      if (!seoData.ogImage) {
        warnings.push({ severity: "medium", message: "Missing og:image meta tag" });
        score -= 0.5;
      }

      // Heading checks
      const h1Count = seoData.h1Count ?? (seoData.headings ? seoData.headings.filter((h) => h.level === 1).length : undefined);
      if (h1Count === 0 || h1Count === undefined) {
        warnings.push({ severity: "high", message: "No <h1> tag found" });
        score -= 1.5;
      } else if (h1Count > 1) {
        warnings.push({ severity: "medium", message: `Multiple <h1> tags found (${h1Count}) — use only one` });
        score -= 0.5;
      }

      // Heading hierarchy issues
      if (seoData.headings && Array.isArray(seoData.headings)) {
        let lastLevel = 0;
        for (const h of seoData.headings) {
          const level = h.level || parseInt(h.tag?.replace("h", "") || "0", 10);
          if (level > lastLevel + 1 && lastLevel > 0) {
            warnings.push({
              severity: "low",
              message: `Heading hierarchy skip: h${lastLevel} followed by h${level} — "${(h.text || "").slice(0, 50)}"`,
            });
            score -= 0.25;
          }
          lastLevel = level;
        }
      }

      // Images missing alt text
      if (seoData.imagesWithoutAlt !== undefined && seoData.imagesWithoutAlt > 0) {
        warnings.push({
          severity: "medium",
          message: `${seoData.imagesWithoutAlt} image(s) missing alt text`,
        });
        score -= 0.5;
      }

      // No structured data
      if (!seoData.structuredData || (Array.isArray(seoData.structuredData) && seoData.structuredData.length === 0)) {
        warnings.push({ severity: "low", message: "No structured data (JSON-LD/microdata) found" });
        score -= 0.5;
      }

      // Clamp score
      score = Math.max(0, Math.round(score * 10) / 10);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            ...seoData,
            score: `${score}/10`,
            warnings,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);

// ---- Tool: security_headers ----
server.tool(
  "security_headers",
  "Analyze security headers, mixed content, and exposed source maps",
  {
    url: z.string().optional(),
  },
  async ({ url }) => {
    const pg = await ensurePage();
    try {
      const targetUrl = url || pg.url();

      // Navigate to capture response headers
      const response = await pg.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const headers = response ? response.headers() : {};
      lastKnownURL = pg.url();

      const issues = [];
      let score = 10;

      const securityHeaders = {};

      // content-security-policy
      const csp = headers["content-security-policy"];
      const cspRO = headers["content-security-policy-report-only"];
      securityHeaders["content-security-policy"] = csp || null;
      securityHeaders["content-security-policy-report-only"] = cspRO || null;
      if (!csp) {
        if (cspRO) {
          issues.push({ header: "content-security-policy", severity: "medium", message: "CSP is report-only — not enforced" });
          score -= 1;
        } else {
          issues.push({ header: "content-security-policy", severity: "high", message: "Missing CSP header" });
          score -= 2;
        }
      }

      // strict-transport-security
      const hsts = headers["strict-transport-security"];
      securityHeaders["strict-transport-security"] = hsts || null;
      if (!hsts) {
        issues.push({ header: "strict-transport-security", severity: "high", message: "Missing HSTS header" });
        score -= 1.5;
      } else {
        const maxAgeMatch = hsts.match(/max-age=(\d+)/);
        if (maxAgeMatch && parseInt(maxAgeMatch[1], 10) < 31536000) {
          issues.push({ header: "strict-transport-security", severity: "low", message: `HSTS max-age is ${maxAgeMatch[1]}s — recommend at least 31536000 (1 year)` });
          score -= 0.5;
        }
      }

      // x-frame-options
      const xfo = headers["x-frame-options"];
      securityHeaders["x-frame-options"] = xfo || null;
      if (!xfo) {
        issues.push({ header: "x-frame-options", severity: "medium", message: "Missing X-Frame-Options header (clickjacking risk)" });
        score -= 1;
      }

      // x-content-type-options
      const xcto = headers["x-content-type-options"];
      securityHeaders["x-content-type-options"] = xcto || null;
      if (!xcto) {
        issues.push({ header: "x-content-type-options", severity: "medium", message: "Missing X-Content-Type-Options header — should be 'nosniff'" });
        score -= 1;
      } else if (xcto.toLowerCase() !== "nosniff") {
        issues.push({ header: "x-content-type-options", severity: "medium", message: `X-Content-Type-Options is "${xcto}" — should be "nosniff"` });
        score -= 0.5;
      }

      // referrer-policy
      const rp = headers["referrer-policy"];
      securityHeaders["referrer-policy"] = rp || null;
      if (!rp) {
        issues.push({ header: "referrer-policy", severity: "medium", message: "Missing Referrer-Policy header" });
        score -= 1;
      }

      // permissions-policy
      const pp = headers["permissions-policy"];
      securityHeaders["permissions-policy"] = pp || null;
      if (!pp) {
        issues.push({ header: "permissions-policy", severity: "low", message: "Missing Permissions-Policy header" });
        score -= 0.5;
      }

      // x-xss-protection (legacy)
      const xxp = headers["x-xss-protection"];
      securityHeaders["x-xss-protection"] = xxp || null;
      if (xxp) {
        issues.push({ header: "x-xss-protection", severity: "info", message: "X-XSS-Protection is set (legacy header — modern browsers ignore it, CSP is preferred)" });
      }

      // Mixed content check
      const mixedContent = await pg.evaluate(() => {
        const mixed = [];
        // Check all resource-loading elements
        const selectors = {
          img: "src",
          script: "src",
          link: "href",
          iframe: "src",
          video: "src",
          audio: "src",
          source: "src",
          object: "data",
        };
        if (location.protocol !== "https:") return mixed;
        for (const [tag, attr] of Object.entries(selectors)) {
          document.querySelectorAll(tag).forEach((el) => {
            const val = el.getAttribute(attr);
            if (val && val.startsWith("http://")) {
              mixed.push({ tag, url: val.slice(0, 200) });
            }
          });
        }
        return mixed;
      });

      if (mixedContent.length > 0) {
        issues.push({
          header: "mixed-content",
          severity: "high",
          message: `${mixedContent.length} resource(s) loaded over HTTP on HTTPS page`,
        });
        score -= 1;
      }

      // Exposed source maps
      const exposedSourceMaps = await pg.evaluate(() => {
        const maps = [];
        document.querySelectorAll("script[src]").forEach((script) => {
          // We can't easily read cross-origin script content, so just note external scripts
          // For inline scripts, check for sourceMappingURL
        });
        // Check inline scripts
        document.querySelectorAll("script:not([src])").forEach((script) => {
          const content = script.textContent || "";
          const match = content.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/);
          if (match) {
            maps.push({ type: "inline", url: match[1] });
          }
        });
        // Check link elements for source maps
        document.querySelectorAll('link[rel="sourcemap"]').forEach((link) => {
          maps.push({ type: "link", url: link.href });
        });
        return maps;
      });

      // Also check loaded script responses for sourceMappingURL header
      // (this is best-effort — the bridge may have captured this)

      if (exposedSourceMaps.length > 0) {
        issues.push({
          header: "source-maps",
          severity: "low",
          message: `${exposedSourceMaps.length} exposed source map(s) found in production`,
        });
        score -= 0.5;
      }

      // Clamp score
      score = Math.max(0, Math.round(score * 10) / 10);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            url: targetUrl,
            headers: securityHeaders,
            score: `${score}/10`,
            issues,
            mixedContent,
            exposedSourceMaps,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, reason: err.message }) }],
      };
    }
  }
);


// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
async function shutdown() {
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
