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
  ms: z.number().optional(),
  url: z.string().optional(),
  name: z.string().optional(),
  fullPage: z.boolean().optional(),
  value: z.string().optional(),
  filePath: z.string().optional(),
  waitUntil: z.string().optional(),
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
