#!/usr/bin/env node

import puppeteer from 'puppeteer';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ANSI colors ──────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// ── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    url: 'http://localhost:3000',
    headless: true,
    output: '/tmp/fastbrowser',
    files: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' && i + 1 < args.length) {
      opts.url = args[++i];
    } else if (arg === '--headless') {
      opts.headless = true;
    } else if (arg === '--no-headless') {
      opts.headless = false;
    } else if (arg === '--output' && i + 1 < args.length) {
      opts.output = args[++i];
    } else if (!arg.startsWith('--')) {
      opts.files.push(arg);
    }
  }

  return opts;
}

// ── Step executor ────────────────────────────────────────────────────────────

async function executeStep(page, step, checkpoints, outputDir) {
  const action = step.action;
  const timeout = step.timeout ?? 5000;
  const t0 = performance.now();
  const result = { action, ok: true };

  try {
    switch (action) {
      case 'navigate': {
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout });
        result.url = step.url;
        break;
      }

      case 'click': {
        const el = await page.waitForSelector(step.selector, { visible: true, timeout });
        await el.click();
        result.selector = step.selector;
        break;
      }

      case 'type': {
        await page.keyboard.type(step.text, { delay: step.delay ?? 0 });
        result.text = step.text;
        break;
      }

      case 'fill': {
        const el = await page.waitForSelector(step.selector, { visible: true, timeout });
        // Triple-click to select all, then type replacement
        await el.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await el.type(step.value, { delay: step.delay ?? 0 });
        result.selector = step.selector;
        break;
      }

      case 'press': {
        await page.keyboard.press(step.key);
        result.key = step.key;
        break;
      }

      case 'scroll': {
        const deltaX = step.deltaX ?? 0;
        const deltaY = step.deltaY ?? 0;
        if (step.selector) {
          const el = await page.waitForSelector(step.selector, { timeout });
          await el.evaluate((node, dx, dy) => {
            node.scrollBy(dx, dy);
          }, deltaX, deltaY);
        } else {
          await page.mouse.wheel({ deltaX, deltaY });
        }
        result.deltaY = deltaY;
        break;
      }

      case 'hover': {
        const el = await page.waitForSelector(step.selector, { visible: true, timeout });
        await el.hover();
        result.selector = step.selector;
        break;
      }

      case 'waitFor': {
        await page.waitForSelector(step.selector, { visible: true, timeout });
        result.selector = step.selector;
        break;
      }

      case 'waitForGone': {
        await page.waitForSelector(step.selector, { hidden: true, timeout });
        result.selector = step.selector;
        break;
      }

      case 'waitForNetwork': {
        const idleTimeout = step.idle ?? 500;
        await waitForNetworkIdle(page, timeout, idleTimeout);
        break;
      }

      case 'waitForFunction': {
        await page.waitForFunction(step.js, { timeout });
        result.js = step.js;
        break;
      }

      case 'assertVisible': {
        const el = await page.waitForSelector(step.selector, { visible: true, timeout });
        if (!el) {
          throw new Error(`Element not visible: ${step.selector}`);
        }
        result.selector = step.selector;
        break;
      }

      case 'assertText': {
        const el = await page.waitForSelector(step.selector, { visible: true, timeout });
        const text = await el.evaluate(node => (node.textContent || '').trim());
        if (step.contains && !text.includes(step.contains)) {
          throw new Error(`Text "${text.slice(0, 100)}" does not contain "${step.contains}"`);
        }
        if (step.equals && text !== step.equals) {
          throw new Error(`Text "${text.slice(0, 100)}" does not equal "${step.equals}"`);
        }
        if (step.matches && !new RegExp(step.matches).test(text)) {
          throw new Error(`Text "${text.slice(0, 100)}" does not match /${step.matches}/`);
        }
        result.text = text.slice(0, 200);
        break;
      }

      case 'assertCount': {
        const elements = await page.$$(step.selector);
        const count = elements.length;
        if (step.equals !== undefined && count !== step.equals) {
          throw new Error(`Count ${count} does not equal ${step.equals}`);
        }
        if (step.min !== undefined && count < step.min) {
          throw new Error(`Count ${count} is less than min ${step.min}`);
        }
        if (step.max !== undefined && count > step.max) {
          throw new Error(`Count ${count} is greater than max ${step.max}`);
        }
        result.count = count;
        break;
      }

      case 'assertURL': {
        const currentUrl = page.url();
        if (step.equals && currentUrl !== step.equals) {
          throw new Error(`URL "${currentUrl}" does not equal "${step.equals}"`);
        }
        if (step.contains && !currentUrl.includes(step.contains)) {
          throw new Error(`URL "${currentUrl}" does not contain "${step.contains}"`);
        }
        if (step.matches && !new RegExp(step.matches).test(currentUrl)) {
          throw new Error(`URL "${currentUrl}" does not match /${step.matches}/`);
        }
        result.url = currentUrl;
        break;
      }

      case 'eval': {
        const value = await page.evaluate(step.js);
        result.value = value;
        break;
      }

      case 'wait': {
        await new Promise(r => setTimeout(r, step.ms ?? 1000));
        result.ms = step.ms;
        break;
      }

      case 'screenshot': {
        mkdirSync(outputDir, { recursive: true });
        const name = step.name ?? `screenshot-${Date.now()}`;
        const filePath = resolve(outputDir, `${name}.png`);
        const screenshotOpts = { path: filePath };
        if (step.selector) {
          const el = await page.waitForSelector(step.selector, { timeout });
          await el.screenshot(screenshotOpts);
        } else {
          await page.screenshot({ ...screenshotOpts, fullPage: step.fullPage ?? false });
        }
        result.path = filePath;
        break;
      }

      case 'select': {
        const el = await page.waitForSelector(step.selector, { timeout });
        const values = Array.isArray(step.value) ? step.value : [step.value];
        await el.select(...values);
        result.selector = step.selector;
        break;
      }

      case 'upload': {
        const el = await page.waitForSelector(step.selector, { timeout });
        const files = Array.isArray(step.files) ? step.files : [step.files];
        await el.uploadFile(...files);
        result.selector = step.selector;
        break;
      }

      case 'checkpoint': {
        const cookies = await page.cookies();
        const state = await page.evaluate(() => window.__fb.getState());
        const url = page.url();
        checkpoints.set(step.name, { cookies, state, url });
        result.name = step.name;
        break;
      }

      case 'restore': {
        const cp = checkpoints.get(step.name);
        if (!cp) {
          throw new Error(`Checkpoint "${step.name}" not found`);
        }
        await restoreCheckpoint(page, cp);
        result.name = step.name;
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }

  result.ms = Math.round((performance.now() - t0) * 100) / 100;
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitForNetworkIdle(page, timeout, idleTime = 500) {
  await page.waitForNetworkIdle({ idleTime, timeout });
}

async function restoreCheckpoint(page, checkpoint) {
  await page.setCookie(...checkpoint.cookies);
  await page.goto(checkpoint.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.evaluate((state) => {
    if (window.__fb && window.__fb.restoreState) {
      window.__fb.restoreState(state);
    }
  }, checkpoint.state);
}

// ── Scenario runner ──────────────────────────────────────────────────────────

async function runScenario(page, scenario, checkpoints, outputDir) {
  const results = {
    name: scenario.name,
    description: scenario.description || '',
    steps: [],
    ok: true,
    totalMs: 0,
  };

  // Restore checkpoint if specified
  if (scenario.checkpoint) {
    const cp = checkpoints.get(scenario.checkpoint);
    if (!cp) {
      results.ok = false;
      results.error = `Checkpoint "${scenario.checkpoint}" not found — skipping scenario`;
      return results;
    }
    try {
      await restoreCheckpoint(page, cp);
    } catch (err) {
      results.ok = false;
      results.error = `Failed to restore checkpoint "${scenario.checkpoint}": ${err.message}`;
      return results;
    }
  }

  const t0 = performance.now();

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const stepResult = await executeStep(page, step, checkpoints, outputDir);
    results.steps.push(stepResult);

    if (!stepResult.ok) {
      results.ok = false;
      results.failedStep = i;
      results.error = `Step ${i + 1} (${step.action}) failed: ${stepResult.error}`;
      break;
    }
  }

  results.totalMs = Math.round((performance.now() - t0) * 100) / 100;
  return results;
}

// ── Output formatting ────────────────────────────────────────────────────────

function printStepResult(index, step, result) {
  const icon = result.ok
    ? `${c.green}\u2713${c.reset}`
    : `${c.red}\u2717${c.reset}`;
  const timing = `${c.dim}${result.ms}ms${c.reset}`;
  const label = formatStepLabel(step);

  process.stdout.write(`    ${icon} ${c.gray}${String(index + 1).padStart(2)}${c.reset} ${label} ${timing}`);

  if (!result.ok) {
    process.stdout.write(`\n       ${c.red}${result.error}${c.reset}`);
  }

  process.stdout.write('\n');
}

function formatStepLabel(step) {
  switch (step.action) {
    case 'navigate': return `navigate ${c.cyan}${step.url}${c.reset}`;
    case 'click': return `click ${c.cyan}${step.selector}${c.reset}`;
    case 'type': return `type ${c.cyan}"${step.text}"${c.reset}`;
    case 'fill': return `fill ${c.cyan}${step.selector}${c.reset} = "${step.value}"`;
    case 'press': return `press ${c.cyan}${step.key}${c.reset}`;
    case 'scroll': return `scroll ${c.cyan}dy=${step.deltaY ?? 0}${c.reset}`;
    case 'hover': return `hover ${c.cyan}${step.selector}${c.reset}`;
    case 'waitFor': return `waitFor ${c.cyan}${step.selector}${c.reset}`;
    case 'waitForGone': return `waitForGone ${c.cyan}${step.selector}${c.reset}`;
    case 'waitForNetwork': return `waitForNetwork`;
    case 'waitForFunction': return `waitForFunction`;
    case 'assertVisible': return `assertVisible ${c.cyan}${step.selector}${c.reset}`;
    case 'assertText': return `assertText ${c.cyan}${step.selector}${c.reset}`;
    case 'assertCount': return `assertCount ${c.cyan}${step.selector}${c.reset}`;
    case 'assertURL': return `assertURL`;
    case 'eval': return `eval ${c.dim}${step.js.slice(0, 60)}${c.reset}`;
    case 'wait': return `wait ${c.cyan}${step.ms ?? 1000}ms${c.reset}`;
    case 'screenshot': return `screenshot ${c.cyan}${step.name ?? 'unnamed'}${c.reset}`;
    case 'select': return `select ${c.cyan}${step.selector}${c.reset}`;
    case 'upload': return `upload ${c.cyan}${step.selector}${c.reset}`;
    case 'checkpoint': return `checkpoint ${c.cyan}${step.name}${c.reset}`;
    case 'restore': return `restore ${c.cyan}${step.name}${c.reset}`;
    default: return `${step.action}`;
  }
}

function printScenarioHeader(scenario, index, total) {
  const checkpoint = scenario.checkpoint
    ? ` ${c.dim}(from checkpoint: ${scenario.checkpoint})${c.reset}`
    : '';
  console.log(`\n${c.bold}[${index + 1}/${total}] ${scenario.name}${c.reset}${checkpoint}`);
  if (scenario.description) {
    console.log(`  ${c.dim}${scenario.description}${c.reset}`);
  }
}

function printSummary(allResults) {
  const passed = allResults.filter(r => r.ok).length;
  const failed = allResults.filter(r => !r.ok).length;
  const totalMs = allResults.reduce((sum, r) => sum + r.totalMs, 0);
  const totalSteps = allResults.reduce((sum, r) => sum + r.steps.length, 0);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${c.bold}Summary${c.reset}`);
  console.log(`${'─'.repeat(60)}`);

  for (const r of allResults) {
    const icon = r.ok
      ? `${c.green}\u2713${c.reset}`
      : `${c.red}\u2717${c.reset}`;
    const timing = `${c.dim}${r.totalMs}ms${c.reset}`;
    console.log(`  ${icon} ${r.name} ${timing}`);
    if (!r.ok && r.error) {
      console.log(`    ${c.red}${r.error}${c.reset}`);
    }
  }

  console.log(`${'─'.repeat(60)}`);

  const statusColor = failed > 0 ? c.red : c.green;
  console.log(
    `${statusColor}${c.bold}${passed} passed${c.reset}, ` +
    `${failed > 0 ? c.red + c.bold : c.dim}${failed} failed${c.reset}, ` +
    `${c.dim}${totalSteps} steps, ${Math.round(totalMs)}ms total${c.reset}`
  );
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.files.length === 0) {
    console.log(`${c.yellow}Usage: node run-scenarios.js [--url URL] [--headless] [--no-headless] [--output DIR] <scenario files...>${c.reset}`);
    console.log(`${c.dim}Example: node run-scenarios.js scenarios/*.json${c.reset}`);
    process.exit(1);
  }

  // Load bridge.js
  const bridgePath = resolve(__dirname, 'bridge.js');
  if (!existsSync(bridgePath)) {
    console.error(`${c.red}bridge.js not found at ${bridgePath}${c.reset}`);
    process.exit(1);
  }
  const bridgeScript = readFileSync(bridgePath, 'utf-8');

  // Load scenario files
  const scenarios = [];
  for (const file of opts.files) {
    const filePath = resolve(file);
    if (!existsSync(filePath)) {
      console.log(`${c.yellow}Warning: scenario file not found, skipping: ${filePath}${c.reset}`);
      continue;
    }
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const scenario = JSON.parse(raw);
      scenario._file = filePath;
      scenarios.push(scenario);
    } catch (err) {
      console.log(`${c.yellow}Warning: failed to parse ${filePath}: ${err.message}${c.reset}`);
    }
  }

  if (scenarios.length === 0) {
    console.log(`${c.yellow}No valid scenario files found.${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.bold}fastbrowser scenario runner${c.reset}`);
  console.log(`${c.dim}URL: ${opts.url}${c.reset}`);
  console.log(`${c.dim}Headless: ${opts.headless}${c.reset}`);
  console.log(`${c.dim}Output: ${opts.output}${c.reset}`);
  console.log(`${c.dim}Scenarios: ${scenarios.length}${c.reset}`);

  // Launch browser
  const browser = await puppeteer.launch({
    headless: opts.headless ? 'new' : false,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Inject bridge.js on every navigation
  await page.evaluateOnNewDocument(bridgeScript);

  // Navigate to initial URL
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (err) {
    console.error(`${c.red}Failed to navigate to ${opts.url}: ${err.message}${c.reset}`);
    await browser.close();
    process.exit(1);
  }

  // Run scenarios
  const checkpoints = new Map();
  const allResults = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    printScenarioHeader(scenario, i, scenarios.length);

    const scenarioOutputDir = resolve(opts.output, scenario.name.replace(/[^a-zA-Z0-9_-]/g, '_'));
    const result = await runScenario(page, scenario, checkpoints, scenarioOutputDir);
    allResults.push(result);

    // Print step details
    for (let j = 0; j < result.steps.length; j++) {
      printStepResult(j, scenario.steps[j], result.steps[j]);
    }

    if (!result.ok && result.error && result.steps.length === 0) {
      // Scenario-level error (e.g. checkpoint not found)
      console.log(`    ${c.red}${result.error}${c.reset}`);
    }
  }

  // Summary
  printSummary(allResults);

  // Cleanup
  await browser.close();

  // Exit code
  const anyFailed = allResults.some(r => !r.ok);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error(`${c.red}Fatal error: ${err.message}${c.reset}`);
  process.exit(1);
});
