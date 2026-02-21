#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import {
  EXIT_ENV,
  EXIT_USAGE,
  SCHEMA_VERSION,
} from "./shared/constants";
import { CliError } from "./shared/errors/cli-error";
import { SuggestLang } from "./shared/types";
import { assertNoExtraArgs, parseGlobalOptions, takeOption } from "./shared/cli-args";
import {
  makeTable,
  nowIso,
  promptSecret,
  writeStderr,
  writeStdout,
} from "./shared/cli-io";
import { commandExists } from "./shared/system";
import {
  ensureDir,
  initializeDataDir,
  loadGlobalConfig,
  loadSecrets,
  loadVault,
  resolveDataDir,
  saveGlobalConfig,
  saveSecrets,
  saveVault,
} from "./infrastructure/persistence/local-store";
import {
  detectSourceType,
  extractProfileFromSources,
  extractTextFromFile,
} from "./features/vault/application/profile-extraction";
import {
  composeExportMarkdown,
  exportMarkdownFile,
} from "./features/export/application/export-markdown.use-case";
import {
  cmdFields,
  cmdRevert,
  cmdRun,
} from "./features/runner/interface/cli/runner-commands";
import { cmdSuggest } from "./features/suggest/interface/cli/suggest.command";
import { cmdApply } from "./features/apply/interface/cli/apply.command";
import { cmdHistory } from "./features/history/interface/cli/history.command";

function printHelp(): void {
  writeStdout("Dalil CLI (MVP v0.1)");
  writeStdout("");
  writeStdout("Setup");
  writeStdout("  dalil init --data-dir <path>");
  writeStdout("  dalil config set openai.key");
  writeStdout("  dalil doctor");
  writeStdout("  dalil run [--mode managed|attach] [--cdp <url>] [--port <n>] [--daemon]");
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
