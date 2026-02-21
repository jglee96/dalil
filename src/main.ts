#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import {
  EXIT_ENV,
  EXIT_INSERTION_BLOCKED,
  EXIT_USAGE,
  RUNNER_DEFAULT_PORT,
  SCHEMA_VERSION,
} from "./shared/constants";
import { CliError } from "./shared/errors/cli-error";
import {
  Citation,
  FormField,
  Mode,
  RunnerConnection,
  SuggestLang,
  SuggestVariant,
  Suggestion,
} from "./shared/types";
import { assertNoExtraArgs, parseGlobalOptions, takeFlag, takeOption } from "./shared/cli-args";
import {
  ensureOpenAiConfirmation,
  inferSite,
  makeTable,
  nowIso,
  promptSecret,
  readStdinText,
  redactValue,
  writeStderr,
  writeStdout,
} from "./shared/cli-io";
import { commandExists } from "./shared/system";
import {
  ensureDir,
  initializeDataDir,
  loadGlobalConfig,
  loadHistory,
  loadRunnerConnection,
  loadSecrets,
  loadSuggestions,
  loadVault,
  pathInDataDir,
  resolveDataDir,
  runnerConnectionPath,
  saveGlobalConfig,
  saveHistory,
  saveRunnerConnection,
  saveSecrets,
  saveSuggestions,
  saveVault,
  saveRuntimeState,
} from "./infrastructure/persistence/local-store";
import {
  detectSourceType,
  extractProfileFromSources,
  extractTextFromFile,
} from "./features/vault/application/profile-extraction";
import {
  callOpenAiSuggestion,
  composeFallbackSuggestion,
  OpenAISuggestionResult,
  pickRelevantCitations,
} from "./features/suggest/application/suggestion-generator";
import {
  composeExportMarkdown,
  exportMarkdownFile,
} from "./features/export/application/export-markdown.use-case";

function parseUrlBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function makeFieldId(domPath: string, label: string, type: string): string {
  const digest = createHash("sha1")
    .update(`${domPath}::${label}::${type}`)
    .digest("hex")
    .slice(0, 12);
  return `fld_${digest}`;
}

async function scanFieldsOnPage(page: any): Promise<FormField[]> {
  const raw = (await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("input:not([type=hidden]):not([type=password]):not([type=file]), textarea"),
    ) as Array<HTMLInputElement | HTMLTextAreaElement>;

    const uniq = (arr: string[]): string[] => Array.from(new Set(arr.map((v) => v.trim()).filter(Boolean)));

    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        let part = node.tagName.toLowerCase();
        if ((node as HTMLElement).id) {
          part += `#${CSS.escape((node as HTMLElement).id)}`;
          parts.unshift(part);
          break;
        }
        const parent = node.parentElement;
        if (parent) {
          const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node?.tagName);
          if (sameTagSiblings.length > 1) {
            const idx = sameTagSiblings.indexOf(node) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };

    const readLabel = (el: HTMLInputElement | HTMLTextAreaElement): string => {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "";
      if (byFor && byFor.trim()) {
        return byFor.trim();
      }
      const wrapping = el.closest("label")?.textContent;
      if (wrapping && wrapping.trim()) {
        return wrapping.trim();
      }
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) {
        return aria.trim();
      }
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const nodes = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean);
        if (nodes.length > 0) {
          return nodes.join(" ");
        }
      }
      return el.getAttribute("name") || el.getAttribute("placeholder") || "(unlabeled field)";
    };

    const nearbyHints = (el: HTMLInputElement | HTMLTextAreaElement): string[] => {
      const hints: string[] = [];
      const parent = el.parentElement;
      if (!parent) {
        return hints;
      }
      const selectors = [".help", ".hint", ".description", ".helper", "[data-help]", "[data-hint]"];
      for (const selector of selectors) {
        parent.querySelectorAll(selector).forEach((node) => hints.push(node.textContent?.trim() || ""));
      }
      const siblingText = Array.from(parent.children)
        .filter((n) => n !== el)
        .map((n) => n.textContent?.trim() || "")
        .filter((txt) => /character|자|글자|word|영문|한글/i.test(txt));
      hints.push(...siblingText);
      return uniq(hints).slice(0, 4);
    };

    return nodes.map((el) => ({
      domPath: cssPath(el),
      type: el.tagName.toLowerCase() === "textarea" ? "textarea" : `input:${(el as HTMLInputElement).type || "text"}`,
      name: el.getAttribute("name") || undefined,
      label: readLabel(el),
      placeholder: el.getAttribute("placeholder") || undefined,
      hints: nearbyHints(el),
      required: el.required,
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : undefined,
      pattern: el.getAttribute("pattern") || undefined,
    }));
  })) as Array<{
    domPath: string;
    type: string;
    name?: string;
    label: string;
    placeholder?: string;
    hints: string[];
    required: boolean;
    maxLength?: number;
    pattern?: string;
  }>;

  const fields = raw.map((f) => {
    const languageHint = f.hints.find((hint) => /영문|english|한글|korean/i.test(hint));
    return {
      fieldId: makeFieldId(f.domPath, f.label, f.type),
      domPath: f.domPath,
      type: f.type,
      name: f.name,
      label: f.label,
      placeholder: f.placeholder,
      hints: f.hints,
      constraints: {
        required: f.required,
        maxLength: f.maxLength,
        pattern: f.pattern,
        languageHint,
      },
    } as FormField;
  });

  return fields;
}

async function ensureFieldExists(page: any, domPath: string): Promise<boolean> {
  const exists = (await page.evaluate((selector: string) => {
    return Boolean(document.querySelector(selector));
  }, domPath)) as boolean;
  return exists;
}

async function highlightField(page: any, domPath: string): Promise<void> {
  await page.evaluate((selector: string) => {
    const node = document.querySelector(selector) as HTMLElement | null;
    if (!node) {
      throw new Error("Field not found");
    }
    const original = node.style.outline;
    node.style.outline = "3px solid #ff6b00";
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      node.style.outline = original;
    }, 2000);
  }, domPath);
}

async function readFieldValue(page: any, domPath: string): Promise<string> {
  const value = (await page.evaluate((selector: string) => {
    const node = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!node) {
      throw new Error("Field not found");
    }
    return node.value || "";
  }, domPath)) as string;
  return value;
}

async function setFieldValue(page: any, domPath: string, text: string): Promise<void> {
  await page.evaluate(
    ({ selector, payload }: { selector: string; payload: string }) => {
      const node = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!node) {
        throw new Error("Field not found");
      }
      node.value = payload;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { selector: domPath, payload: text },
  );
}

async function typeIntoField(page: any, domPath: string, text: string): Promise<void> {
  const locator = page.locator(domPath).first();
  await locator.click();
  await locator.fill("");
  await locator.type(text, { delay: 4 });
}

async function getPageInfo(page: any): Promise<{ url?: string; title?: string }> {
  const info = (await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
  }))) as { url?: string; title?: string };
  return info;
}

async function startRunnerServer(params: {
  dataDir: string;
  mode: Mode;
  cdpUrl?: string;
  requestedPort?: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  let playwrightModule: any;
  try {
    playwrightModule = await import("playwright");
  } catch {
    throw new CliError(
      "Playwright is not installed. Install with `npm i playwright` and run again.",
      EXIT_ENV,
    );
  }

  const chromium = playwrightModule.chromium;
  if (!chromium) {
    throw new CliError("Playwright Chromium module is unavailable.", EXIT_ENV);
  }

  let browser: any;
  let context: any;
  let page: any;

  if (params.mode === "managed") {
    const profileDir = pathInDataDir(params.dataDir, "runner-profile");
    ensureDir(profileDir);
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
    });
    page = context.pages()[0] ?? (await context.newPage());
  } else {
    if (!params.cdpUrl) {
      throw new CliError("Attach mode requires `--cdp <url>`.", EXIT_USAGE);
    }
    browser = await chromium.connectOverCDP(params.cdpUrl);
    context = browser.contexts()[0];
    if (!context) {
      throw new CliError("No browser context is available in attached browser.", EXIT_ENV);
    }
    page = context.pages()[0] ?? (await context.newPage());
  }

  await context.addInitScript(() => {
    const originalSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function blockedSubmit(): void {
      console.warn("Dalil blocked form.submit()");
    };
    Object.defineProperty(window, "__dalil_original_submit__", {
      value: originalSubmit,
      configurable: false,
      writable: false,
    });
  });

  const state: {
    fields: FormField[];
    undo: Map<string, string>;
  } = {
    fields: [],
    undo: new Map<string, string>(),
  };

  const scanAndPersist = async (): Promise<FormField[]> => {
    state.fields = await scanFieldsOnPage(page);
    saveRuntimeState(params.dataDir, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowIso(),
      fields: state.fields,
    });
    return state.fields;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = reqUrl.pathname;

      if (method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, mode: params.mode });
        return;
      }
      if (method === "POST" && pathname === "/scan_fields") {
        const fields = await scanAndPersist();
        sendJson(res, 200, { ok: true, fields });
        return;
      }
      if (method === "GET" && pathname === "/fields") {
        sendJson(res, 200, { ok: true, fields: state.fields });
        return;
      }
      if (method === "GET" && pathname.startsWith("/field/")) {
        const fieldId = decodeURIComponent(pathname.replace("/field/", ""));
        const field = state.fields.find((f) => f.fieldId === fieldId);
        if (!field) {
          sendJson(res, 404, { ok: false, error: "Field not found. Run scan first." });
          return;
        }
        sendJson(res, 200, { ok: true, field });
        return;
      }
      if (method === "GET" && pathname === "/page_info") {
        const info = await getPageInfo(page);
        sendJson(res, 200, { ok: true, page: info });
        return;
      }
      if (method === "POST" && pathname === "/highlight_field") {
        const body = (await parseUrlBody(req)) as { fieldId?: string };
        const field = state.fields.find((f) => f.fieldId === body.fieldId);
        if (!field) {
          sendJson(res, 404, { ok: false, error: "Field not found." });
          return;
        }
        await highlightField(page, field.domPath);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && pathname === "/read_field_value") {
        const body = (await parseUrlBody(req)) as { fieldId?: string };
        const field = state.fields.find((f) => f.fieldId === body.fieldId);
        if (!field) {
          sendJson(res, 404, { ok: false, error: "Field not found." });
          return;
        }
        const value = await readFieldValue(page, field.domPath);
        sendJson(res, 200, { ok: true, value });
        return;
      }
      if (method === "POST" && pathname === "/set_field_value") {
        const body = (await parseUrlBody(req)) as { fieldId?: string; text?: string };
        const field = state.fields.find((f) => f.fieldId === body.fieldId);
        if (!field) {
          sendJson(res, 404, { ok: false, error: "Field not found." });
          return;
        }
        if (!(await ensureFieldExists(page, field.domPath))) {
          sendJson(res, 410, { ok: false, error: "Field no longer exists on page." });
          return;
        }
        const prev = await readFieldValue(page, field.domPath);
        state.undo.set(field.fieldId, prev);
        await setFieldValue(page, field.domPath, body.text ?? "");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && pathname === "/type_into_field") {
        const body = (await parseUrlBody(req)) as { fieldId?: string; text?: string };
        const field = state.fields.find((f) => f.fieldId === body.fieldId);
        if (!field) {
          sendJson(res, 404, { ok: false, error: "Field not found." });
          return;
        }
        const prev = await readFieldValue(page, field.domPath);
        state.undo.set(field.fieldId, prev);
        await typeIntoField(page, field.domPath, body.text ?? "");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && pathname === "/revert_field") {
        const body = (await parseUrlBody(req)) as { fieldId?: string };
        const field = state.fields.find((f) => f.fieldId === body.fieldId);
        if (!field) {
          sendJson(res, 404, { ok: false, error: "Field not found." });
          return;
        }
        const previous = state.undo.get(field.fieldId);
        if (previous === undefined) {
          sendJson(res, 404, { ok: false, error: "No undo snapshot available." });
          return;
        }
        await setFieldValue(page, field.domPath, previous);
        state.undo.delete(field.fieldId);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Unknown endpoint." });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const listenPort = params.requestedPort ?? RUNNER_DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new CliError("Failed to resolve runner server port.", EXIT_ENV);
  }

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (params.mode === "managed") {
      await context.close();
    } else if (browser) {
      await browser.close();
    }
  };

  return { port: address.port, close };
}

async function runnerRequest<T>(dataDir: string, endpoint: string, init?: RequestInit): Promise<T> {
  const conn = loadRunnerConnection(dataDir);
  if (!conn?.port) {
    throw new CliError("Runner is not active. Start it with `dalil run`.", EXIT_ENV);
  }
  const url = `http://127.0.0.1:${conn.port}${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new CliError("Runner connection failed. Is `dalil run` still running?", EXIT_ENV);
  }
  const payload = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!res.ok || !payload.ok) {
    throw new CliError(payload.error ?? `Runner error on ${endpoint}`, EXIT_ENV);
  }
  return payload;
}

function printHelp(): void {
  writeStdout("Dalil CLI (MVP v0.1)");
  writeStdout("");
  writeStdout("Setup");
  writeStdout("  dalil init --data-dir <path>");
  writeStdout("  dalil config set openai.key");
  writeStdout("  dalil doctor");
  writeStdout("  dalil run [--mode managed|attach] [--cdp <url>] [--port <n>]");
  writeStdout("");
  writeStdout("Vault");
  writeStdout("  dalil vault import <file...> [--type resume|portfolio|notes]");
  writeStdout("  dalil vault status");
  writeStdout("");
  writeStdout("Fields");
  writeStdout("  dalil fields list [--format table|json]");
  writeStdout("  dalil fields show <fieldId>");
  writeStdout("  dalil fields highlight <fieldId>");
  writeStdout("");
  writeStdout("Suggestions");
  writeStdout("  dalil suggest <fieldId> [--variant concise|standard|impact] [--lang ko|en]");
  writeStdout("  dalil suggest --all [--variant ...] [--lang ...]");
  writeStdout("  dalil suggest show <suggestionId> [--with-citations]");
  writeStdout("");
  writeStdout("Apply/Revert");
  writeStdout("  dalil apply <fieldId> --suggestion <suggestionId>");
  writeStdout("  dalil apply <fieldId> --text @-");
  writeStdout("  dalil revert <fieldId>");
  writeStdout("");
  writeStdout("History");
  writeStdout("  dalil history list [--site <etld+1>] [--limit N]");
  writeStdout("  dalil history show <historyId> [--format text|json]");
  writeStdout("  dalil history search <query>");
  writeStdout("");
  writeStdout("Export");
  writeStdout("  dalil export resume --lang ko|en --template <id> --out <path.md>");
  writeStdout("  dalil export portfolio --lang ko|en --template <id> --out <path.md>");
}

async function cmdInit(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const dataDirArg = takeOption(args, "--data-dir") ?? dataDirOverride;
  if (!dataDirArg) {
    throw new CliError("`dalil init` requires `--data-dir <path>`.", EXIT_USAGE);
  }
  assertNoExtraArgs(args, "init");
  const dataDir = path.resolve(dataDirArg);
  initializeDataDir(dataDir);

  const config = loadGlobalConfig();
  config.schemaVersion = SCHEMA_VERSION;
  config.dataDir = dataDir;
  saveGlobalConfig(config);

  writeStdout(`Initialized Dalil data directory: ${dataDir}`);
}

async function cmdConfig(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const op = args.shift();
  const key = args.shift();
  if (op !== "set" || key !== "openai.key") {
    throw new CliError("Usage: dalil config set openai.key", EXIT_USAGE);
  }
  assertNoExtraArgs(args, "config set openai.key");
  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);
  const apiKey = await promptSecret("OpenAI API key: ");
  if (!apiKey) {
    throw new CliError("API key cannot be empty.", EXIT_USAGE);
  }
  const secrets = loadSecrets(dataDir);
  secrets.schemaVersion = SCHEMA_VERSION;
  secrets.openaiApiKey = apiKey;
  saveSecrets(dataDir, secrets);
  writeStdout("Stored OpenAI key in local data directory secret file.");
}

async function cmdDoctor(dataDirOverride?: string): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string; required: boolean }> = [];
  const dataDir = (() => {
    try {
      return resolveDataDir(dataDirOverride);
    } catch {
      return undefined;
    }
  })();

  checks.push({
    name: "global_config",
    ok: Boolean(loadGlobalConfig().dataDir),
    detail: loadGlobalConfig().dataDir ?? "missing",
    required: true,
  });

  if (dataDir) {
    let writable = false;
    try {
      ensureDir(dataDir);
      fs.accessSync(dataDir, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    checks.push({
      name: "data_dir_writable",
      ok: writable,
      detail: dataDir,
      required: true,
    });
    initializeDataDir(dataDir);
    const secrets = loadSecrets(dataDir);
    checks.push({
      name: "openai_key",
      ok: Boolean(secrets.openaiApiKey),
      detail: secrets.openaiApiKey ? "configured" : "not set",
      required: false,
    });
    if (secrets.openaiApiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${secrets.openaiApiKey}` },
        });
        checks.push({
          name: "openai_connectivity",
          ok: res.ok,
          detail: res.ok ? "ok" : `http ${res.status}`,
          required: true,
        });
      } catch (err) {
        checks.push({
          name: "openai_connectivity",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          required: true,
        });
      }
    }
  }

  let playwrightOk = false;
  try {
    await import("playwright");
    playwrightOk = true;
  } catch {
    playwrightOk = false;
  }
  checks.push({
    name: "playwright",
    ok: playwrightOk,
    detail: playwrightOk ? "installed" : "missing (install with `npm i playwright`)",
    required: false,
  });

  checks.push({
    name: "editor",
    ok: Boolean(process.env.EDITOR),
    detail: process.env.EDITOR ?? "not set",
    required: false,
  });
  checks.push({
    name: "textutil",
    ok: commandExists("textutil"),
    detail: commandExists("textutil") ? "available" : "missing",
    required: false,
  });

  const rows = [["check", "status", "detail"], ...checks.map((c) => [c.name, c.ok ? "ok" : "fail", c.detail])];
  writeStdout(makeTable(rows));

  const hasRequiredFailure = checks.some((c) => c.required && !c.ok);
  if (hasRequiredFailure) {
    throw new CliError("Doctor found required environment failures.", EXIT_ENV);
  }
}

async function cmdVault(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const sub = args.shift();
  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);

  if (sub === "import") {
    const forcedType = takeOption(args, "--type") as "resume" | "portfolio" | "notes" | undefined;
    if (args.length === 0) {
      throw new CliError("Usage: dalil vault import <file...> [--type resume|portfolio|notes]", EXIT_USAGE);
    }
    const files = args.map((f) => path.resolve(f));
    const vault = loadVault(dataDir);
    const imported: Array<{ file: string; parsed: boolean }> = [];

    for (const filePath of files) {
      const sourceType = detectSourceType(filePath, forcedType);
      const text = extractTextFromFile(filePath, sourceType);
      vault.sources.push({
        docId: randomUUID(),
        path: filePath,
        type: sourceType,
        importedAt: nowIso(),
        textSnippet: text.slice(0, 8000),
      });
      imported.push({ file: filePath, parsed: text.length > 0 });
    }

    vault.profile = extractProfileFromSources(vault.sources);
    saveVault(dataDir, vault);

    for (const item of imported) {
      writeStdout(`${item.parsed ? "imported" : "imported (no text parser available)"}: ${item.file}`);
    }
    writeStdout(`Vault updated. Total sources: ${vault.sources.length}`);
    return;
  }

  if (sub === "status") {
    assertNoExtraArgs(args, "vault status");
    const vault = loadVault(dataDir);
    const rows = [
      ["field", "value"],
      ["schema_version", vault.schemaVersion],
      ["vault_version", vault.version],
      ["updated_at", vault.updatedAt],
      ["sources", String(vault.sources.length)],
      ["headline", vault.profile.headline ?? ""],
      ["skills", String(vault.profile.skills.length)],
      ["experience_items", String(vault.profile.experience.length)],
      ["projects", String(vault.profile.projects.length)],
      ["education", String(vault.profile.education.length)],
    ];
    writeStdout(makeTable(rows));
    return;
  }

  throw new CliError("Usage: dalil vault import|status ...", EXIT_USAGE);
}

async function cmdRun(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const modeValue = (takeOption(args, "--mode") ?? "managed") as Mode;
  if (modeValue !== "managed" && modeValue !== "attach") {
    throw new CliError("`--mode` must be managed or attach.", EXIT_USAGE);
  }
  const cdp = takeOption(args, "--cdp");
  const portRaw = takeOption(args, "--port");
  const port = portRaw ? Number(portRaw) : RUNNER_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError("`--port` must be an integer between 1 and 65535.", EXIT_USAGE);
  }
  assertNoExtraArgs(args, "run");

  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);
  const runner = await startRunnerServer({
    dataDir,
    mode: modeValue,
    cdpUrl: cdp,
    requestedPort: port,
  });

  const conn: RunnerConnection = {
    schemaVersion: SCHEMA_VERSION,
    port: runner.port,
    mode: modeValue,
    startedAt: nowIso(),
  };
  saveRunnerConnection(dataDir, conn);

  writeStdout("Dalil Runner started.");
  writeStdout(`mode=${modeValue} port=${runner.port}`);
  writeStdout("Dalil fills text only. You submit manually.");
  writeStdout("Keep this process running and use another terminal for CLI commands.");

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      await runner.close();
    } finally {
      if (fs.existsSync(runnerConnectionPath(dataDir))) {
        fs.rmSync(runnerConnectionPath(dataDir), { force: true });
      }
    }
  };

  process.on("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });

  await new Promise<void>(() => {
    // keep process alive as a runner daemon
  });
}

async function cmdFields(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const sub = args.shift();
  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);

  if (sub === "list") {
    const format = takeOption(args, "--format") ?? (takeFlag(args, "--json") ? "json" : "table");
    assertNoExtraArgs(args, "fields list");
    const payload = await runnerRequest<{ fields: FormField[] }>(dataDir, "/scan_fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    if (format === "json") {
      writeStdout(
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            fields: payload.fields,
          },
          null,
          2,
        ),
      );
      return;
    }
    const rows = [
      ["field_id", "label", "type", "required", "max_length", "lang_hint"],
      ...payload.fields.map((f) => [
        f.fieldId,
        f.label,
        f.type,
        f.constraints.required ? "yes" : "no",
        f.constraints.maxLength ? String(f.constraints.maxLength) : "-",
        f.constraints.languageHint ?? "-",
      ]),
    ];
    writeStdout(makeTable(rows));
    return;
  }

  if (sub === "show") {
    const fieldId = args.shift();
    if (!fieldId) {
      throw new CliError("Usage: dalil fields show <fieldId>", EXIT_USAGE);
    }
    assertNoExtraArgs(args, "fields show");
    const fieldPayload = await runnerRequest<{ field: FormField }>(dataDir, `/field/${encodeURIComponent(fieldId)}`);
    const valuePayload = await runnerRequest<{ value: string }>(dataDir, "/read_field_value", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId }),
    });
    writeStdout(
      JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          field: fieldPayload.field,
          current_value_redacted: redactValue(valuePayload.value),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (sub === "highlight") {
    const fieldId = args.shift();
    if (!fieldId) {
      throw new CliError("Usage: dalil fields highlight <fieldId>", EXIT_USAGE);
    }
    assertNoExtraArgs(args, "fields highlight");
    await runnerRequest(dataDir, "/highlight_field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId }),
    });
    writeStdout(`Highlighted field: ${fieldId}`);
    return;
  }

  throw new CliError("Usage: dalil fields list|show|highlight ...", EXIT_USAGE);
}

async function generateSuggestionForField(params: {
  dataDir: string;
  field: FormField;
  variant: SuggestVariant;
  lang: SuggestLang;
}): Promise<Suggestion> {
  const vault = loadVault(params.dataDir);
  const secrets = loadSecrets(params.dataDir);
  const citations = pickRelevantCitations(vault, params.field);

  let result: OpenAISuggestionResult;
  if (secrets.openaiApiKey) {
    const preview = {
      field: {
        label: params.field.label,
        hints: params.field.hints,
        constraints: params.field.constraints,
      },
      citations,
      profile_excerpt: {
        headline: vault.profile.headline,
        skills: vault.profile.skills.slice(0, 8),
        experience: vault.profile.experience.slice(0, 5),
      },
      variant: params.variant,
      lang: params.lang,
    };
    await ensureOpenAiConfirmation(preview);
    result = await callOpenAiSuggestion({
      apiKey: secrets.openaiApiKey,
      field: params.field,
      profile: vault.profile,
      citations,
      variant: params.variant,
      lang: params.lang,
    });
  } else {
    result = composeFallbackSuggestion(params.field, vault.profile, params.variant, params.lang);
  }

  const suggestion: Suggestion = {
    suggestionId: randomUUID(),
    createdAt: nowIso(),
    fieldId: params.field.fieldId,
    text: result.text,
    variant: params.variant,
    lang: params.lang,
    citations,
    confidence: result.confidence,
    needsConfirmation: result.needsConfirmation || citations.length === 0,
  };
  const store = loadSuggestions(params.dataDir);
  store.suggestions.push(suggestion);
  saveSuggestions(params.dataDir, store);

  return suggestion;
}

async function cmdSuggest(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);

  if (args[0] === "show") {
    args.shift();
    const suggestionId = args.shift();
    if (!suggestionId) {
      throw new CliError("Usage: dalil suggest show <suggestionId> [--with-citations]", EXIT_USAGE);
    }
    const withCitations = takeFlag(args, "--with-citations");
    assertNoExtraArgs(args, "suggest show");
    const store = loadSuggestions(dataDir);
    const suggestion = store.suggestions.find((s) => s.suggestionId === suggestionId);
    if (!suggestion) {
      throw new CliError(`Suggestion not found: ${suggestionId}`, EXIT_USAGE);
    }
    const output: Record<string, unknown> = {
      schemaVersion: SCHEMA_VERSION,
      suggestionId: suggestion.suggestionId,
      fieldId: suggestion.fieldId,
      variant: suggestion.variant,
      lang: suggestion.lang,
      confidence: suggestion.confidence,
      needsConfirmation: suggestion.needsConfirmation,
      text: suggestion.text,
    };
    if (withCitations) {
      output.citations = suggestion.citations;
    }
    writeStdout(JSON.stringify(output, null, 2));
    return;
  }

  const variant = (takeOption(args, "--variant") ?? "standard") as SuggestVariant;
  const lang = (takeOption(args, "--lang") ?? "ko") as SuggestLang;
  if (!["concise", "standard", "impact"].includes(variant)) {
    throw new CliError("`--variant` must be concise|standard|impact.", EXIT_USAGE);
  }
  if (!["ko", "en"].includes(lang)) {
    throw new CliError("`--lang` must be ko|en.", EXIT_USAGE);
  }
  const all = takeFlag(args, "--all");

  if (all) {
    assertNoExtraArgs(args, "suggest --all");
    const scan = await runnerRequest<{ fields: FormField[] }>(dataDir, "/scan_fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const generated: Suggestion[] = [];
    for (const field of scan.fields) {
      const suggestion = await generateSuggestionForField({ dataDir, field, variant, lang });
      generated.push(suggestion);
    }
    const rows = [
      ["field_id", "suggestion_id", "confidence", "needs_confirmation"],
      ...generated.map((s) => [s.fieldId, s.suggestionId, s.confidence, s.needsConfirmation ? "yes" : "no"]),
    ];
    writeStdout(makeTable(rows));
    return;
  }

  const fieldId = args.shift();
  if (!fieldId) {
    throw new CliError("Usage: dalil suggest <fieldId> [--variant ...] [--lang ...]", EXIT_USAGE);
  }
  assertNoExtraArgs(args, "suggest");

  const payload = await runnerRequest<{ field: FormField }>(dataDir, `/field/${encodeURIComponent(fieldId)}`);
  const suggestion = await generateSuggestionForField({
    dataDir,
    field: payload.field,
    variant,
    lang,
  });

  writeStdout(`suggestionId: ${suggestion.suggestionId}`);
  writeStdout(`confidence: ${suggestion.confidence}`);
  writeStdout(`needsConfirmation: ${suggestion.needsConfirmation}`);
  writeStdout("");
  writeStdout(suggestion.text);
}

async function cmdApply(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);

  const fieldId = args.shift();
  if (!fieldId) {
    throw new CliError("Usage: dalil apply <fieldId> --suggestion <id> | --text @-", EXIT_USAGE);
  }

  const suggestionId = takeOption(args, "--suggestion");
  const textOpt = takeOption(args, "--text");
  assertNoExtraArgs(args, "apply");

  if ((suggestionId ? 1 : 0) + (textOpt ? 1 : 0) !== 1) {
    throw new CliError("Use exactly one of `--suggestion` or `--text`.", EXIT_USAGE);
  }

  let text = "";
  let citations: Citation[] = [];
  if (suggestionId) {
    const suggestions = loadSuggestions(dataDir);
    const item = suggestions.suggestions.find((s) => s.suggestionId === suggestionId);
    if (!item) {
      throw new CliError(`Suggestion not found: ${suggestionId}`, EXIT_USAGE);
    }
    text = item.text;
    citations = item.citations;
  } else if (textOpt) {
    if (textOpt === "@-") {
      text = (await readStdinText()).trim();
      if (!text) {
        throw new CliError("No stdin text provided for `--text @-`.", EXIT_USAGE);
      }
    } else {
      text = textOpt;
    }
  }

  const fieldPayload = await runnerRequest<{ field: FormField }>(dataDir, `/field/${encodeURIComponent(fieldId)}`);

  try {
    await runnerRequest(dataDir, "/set_field_value", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId, text }),
    });
  } catch (err) {
    try {
      await runnerRequest(dataDir, "/type_into_field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fieldId, text }),
      });
    } catch {
      throw new CliError(
        `Insertion blocked for ${fieldId}. Fallback typing also failed. Copy text manually.`,
        EXIT_INSERTION_BLOCKED,
      );
    }
    if (err instanceof Error) {
      writeStderr(`programmatic set failed, fallback used: ${err.message}`);
    }
  }

  const pagePayload = await runnerRequest<{ page: { url?: string; title?: string } }>(dataDir, "/page_info");
  const site = inferSite(pagePayload.page.url);

  const history = loadHistory(dataDir);
  history.entries.unshift({
    id: randomUUID(),
    createdAt: nowIso(),
    site,
    page: pagePayload.page,
    fields: [
      {
        label: fieldPayload.field.label,
        constraints: fieldPayload.field.constraints,
        appliedText: text,
        citations,
      },
    ],
  });
  saveHistory(dataDir, history);

  writeStdout(`Applied text to ${fieldId}`);
}

async function cmdRevert(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const fieldId = args.shift();
  if (!fieldId) {
    throw new CliError("Usage: dalil revert <fieldId>", EXIT_USAGE);
  }
  assertNoExtraArgs(args, "revert");
  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);

  await runnerRequest(dataDir, "/revert_field", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fieldId }),
  });
  writeStdout(`Reverted field: ${fieldId}`);
}

async function cmdHistory(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const sub = args.shift();
  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);
  const store = loadHistory(dataDir);

  if (sub === "list") {
    const site = takeOption(args, "--site");
    const limitRaw = takeOption(args, "--limit");
    const limit = limitRaw ? Number(limitRaw) : 20;
    const format = takeOption(args, "--format") ?? (takeFlag(args, "--json") ? "json" : "table");
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new CliError("`--limit` must be a positive integer.", EXIT_USAGE);
    }
    assertNoExtraArgs(args, "history list");

    const filtered = store.entries
      .filter((entry) => (site ? entry.site.etldPlusOne === site : true))
      .slice(0, limit);

    if (format === "json") {
      writeStdout(
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            entries: filtered,
          },
          null,
          2,
        ),
      );
      return;
    }

    const rows = [
      ["history_id", "created_at", "site", "fields"],
      ...filtered.map((entry) => [
        entry.id,
        entry.createdAt,
        entry.site.etldPlusOne ?? entry.site.hostname ?? "-",
        String(entry.fields.length),
      ]),
    ];
    writeStdout(makeTable(rows));
    return;
  }

  if (sub === "show") {
    const id = args.shift();
    if (!id) {
      throw new CliError("Usage: dalil history show <historyId> [--format text|json]", EXIT_USAGE);
    }
    const format = takeOption(args, "--format") ?? (takeFlag(args, "--json") ? "json" : "text");
    assertNoExtraArgs(args, "history show");
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) {
      throw new CliError(`History entry not found: ${id}`, EXIT_USAGE);
    }
    if (format === "json") {
      writeStdout(
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            entry,
          },
          null,
          2,
        ),
      );
      return;
    }
    writeStdout(`id: ${entry.id}`);
    writeStdout(`createdAt: ${entry.createdAt}`);
    writeStdout(`site: ${entry.site.etldPlusOne ?? entry.site.hostname ?? "-"}`);
    writeStdout(`url: ${entry.page.url ?? "-"}`);
    for (const field of entry.fields) {
      writeStdout("");
      writeStdout(`label: ${field.label}`);
      writeStdout(`text: ${field.appliedText}`);
    }
    return;
  }

  if (sub === "search") {
    const query = args.shift();
    if (!query) {
      throw new CliError("Usage: dalil history search <query>", EXIT_USAGE);
    }
    assertNoExtraArgs(args, "history search");
    const q = query.toLowerCase();
    const hits = store.entries.filter((entry) => {
      if (entry.site.hostname?.toLowerCase().includes(q)) {
        return true;
      }
      if (entry.site.etldPlusOne?.toLowerCase().includes(q)) {
        return true;
      }
      return entry.fields.some(
        (f) => f.label.toLowerCase().includes(q) || f.appliedText.toLowerCase().includes(q),
      );
    });
    const rows = [
      ["history_id", "created_at", "site", "preview"],
      ...hits.slice(0, 50).map((entry) => [
        entry.id,
        entry.createdAt,
        entry.site.etldPlusOne ?? entry.site.hostname ?? "-",
        entry.fields[0]?.label ?? "-",
      ]),
    ];
    writeStdout(makeTable(rows));
    return;
  }

  throw new CliError("Usage: dalil history list|show|search ...", EXIT_USAGE);
}

async function cmdExport(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const artifact = args.shift() as "resume" | "portfolio" | undefined;
  if (!artifact || (artifact !== "resume" && artifact !== "portfolio")) {
    throw new CliError("Usage: dalil export resume|portfolio --lang ko|en --template <id> --out <path.md>", EXIT_USAGE);
  }
  const lang = (takeOption(args, "--lang") ?? "ko") as SuggestLang;
  const template = takeOption(args, "--template");
  const outPathRaw = takeOption(args, "--out");
  if (!template || !outPathRaw) {
    throw new CliError("`--template` and `--out` are required.", EXIT_USAGE);
  }
  if (lang !== "ko" && lang !== "en") {
    throw new CliError("`--lang` must be ko|en.", EXIT_USAGE);
  }
  assertNoExtraArgs(args, "export");

  const dataDir = resolveDataDir(dataDirOverride);
  initializeDataDir(dataDir);
  const vault = loadVault(dataDir);
  const content = composeExportMarkdown(vault, artifact, lang, template);
  const outPath = exportMarkdownFile(outPathRaw, content);

  writeStdout(`Exported ${artifact} markdown to ${outPath}`);
}

async function run(): Promise<void> {
  const parsed = parseGlobalOptions(process.argv.slice(2));
  const args = [...parsed.args];
  const command = args.shift();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "init":
      await cmdInit(args, parsed.dataDirOverride);
      return;
    case "config":
      await cmdConfig(args, parsed.dataDirOverride);
      return;
    case "doctor":
      await cmdDoctor(parsed.dataDirOverride);
      return;
    case "run":
      await cmdRun(args, parsed.dataDirOverride);
      return;
    case "vault":
      await cmdVault(args, parsed.dataDirOverride);
      return;
    case "fields":
      await cmdFields(args, parsed.dataDirOverride);
      return;
    case "suggest":
      await cmdSuggest(args, parsed.dataDirOverride);
      return;
    case "apply":
      await cmdApply(args, parsed.dataDirOverride);
      return;
    case "revert":
      await cmdRevert(args, parsed.dataDirOverride);
      return;
    case "history":
      await cmdHistory(args, parsed.dataDirOverride);
      return;
    case "export":
      await cmdExport(args, parsed.dataDirOverride);
      return;
    default:
      throw new CliError(`Unknown command: ${command}`, EXIT_USAGE);
  }
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof CliError) {
      writeStderr(err.message);
      process.exit(err.exitCode);
      return;
    }
    writeStderr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void main();
