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

// ---- Tool: network_log ----
server.tool(
  "network_log",
  "Return recent network requests (fetch/XHR)",
  {
    since: z.number().optional(),
    urlFilter: z.string().optional(),
    statusFilter: z.number().optional(),
    limit: z.number().default(50),
  },
  async ({ since, urlFilter, statusFilter, limit }) => {
    const pg = await ensurePage();
    try {
      if (!networkLogStarted) {
        await pg.evaluate(() => window.__fb.startNetworkLog());
        networkLogStarted = true;
      }

      let requests = await pg.evaluate(() => window.__fb.getNetworkLog()) || [];

      if (since) requests = requests.filter((r) => r.timestamp >= since);
      if (urlFilter) requests = requests.filter((r) => r.url && r.url.includes(urlFilter));
      if (statusFilter) requests = requests.filter((r) => r.status === statusFilter);

      requests = requests.slice(-limit);

      const byStatus = {};
      let totalDuration = 0;
      let totalSize = 0;
      let durationCount = 0;
      for (const r of requests) {
        const s = r.status || "pending";
        byStatus[s] = (byStatus[s] || 0) + 1;
        if (r.duration) { totalDuration += r.duration; durationCount++; }
        if (r.size) totalSize += r.size;
      }

      const summary = {
        total: requests.length,
        byStatus,
        avgDuration: durationCount ? Math.round(totalDuration / durationCount) : null,
        totalSize,
      };

      return {
        content: [{ type: "text", text: JSON.stringify({ requests, summary }, null, 2) }],
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

// ---- Tool: console_log ----
server.tool(
  "console_log",
  "Return buffered console output (log, warn, error)",
  {
    since: z.number().optional(),
    level: z.enum(["log", "warn", "error", "all"]).default("all"),
    clear: z.boolean().default(false),
  },
  async ({ since, level, clear }) => {
    const pg = await ensurePage();
    try {
      let logs = [];

      if (level === "all" || level === "error") {
        const errors = await pg.evaluate(() => window.__fb ? window.__fb.getErrors() : []) || [];
        const errorLogs = errors.map((e) => ({ level: "error", ...e }));
        logs = logs.concat(errorLogs);
      }

      if (level === "all" || level === "log" || level === "warn") {
        const consoleLogs = await pg.evaluate(
          (s) => window.__fb ? window.__fb.getConsoleLogs(s) : [],
          since || undefined
        ) || [];
        if (level === "log") {
          logs = logs.concat(consoleLogs.filter((l) => l.level === "log"));
        } else if (level === "warn") {
          logs = logs.concat(consoleLogs.filter((l) => l.level === "warn"));
        } else {
          logs = logs.concat(consoleLogs);
        }
      }

      if (since) {
        logs = logs.filter((l) => (l.timestamp || 0) >= since);
      }

      if (clear) {
        await pg.evaluate(() => {
          if (window.__fb) {
            window.__fb.clearConsoleLogs();
            window.__fb.clearErrors();
          }
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ logs, count: logs.length }, null, 2) }],
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

// ---- Tool: perf_metrics ----
server.tool(
  "perf_metrics",
  "Get Core Web Vitals and performance metrics",
  {},
  async () => {
    const pg = await ensurePage();
    try {
      const metrics = await pg.evaluate(() => {
        const result = {
          url: location.href,
          title: document.title,
          domNodes: document.querySelectorAll("*").length,
          heapMB: null,
          lcp: null,
          cls: null,
          longTasks: { count: 0, totalMs: 0 },
        };

        // Heap size
        if (performance.memory) {
          result.heapMB = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024 * 100) / 100;
        }

        // LCP
        try {
          const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
          if (lcpEntries.length) {
            result.lcp = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
          }
        } catch {}

        // CLS
        try {
          const layoutShiftEntries = performance.getEntriesByType("layout-shift");
          if (layoutShiftEntries.length) {
            result.cls = 0;
            for (const entry of layoutShiftEntries) {
              if (!entry.hadRecentInput) result.cls += entry.value;
            }
            result.cls = Math.round(result.cls * 1000) / 1000;
          }
        } catch {}

        // Long tasks
        try {
          const longTasks = performance.getEntriesByType("longtask");
          result.longTasks.count = longTasks.length;
          result.longTasks.totalMs = Math.round(longTasks.reduce((sum, t) => sum + t.duration, 0));
        } catch {}

        return result;
      });

      return {
        content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }],
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
