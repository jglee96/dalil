import fs from "node:fs";
import path from "node:path";

import { EXIT_ENV, EXIT_USAGE, SCHEMA_VERSION } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { assertNoExtraArgs, takeOption } from "../../../../shared/cli-args";
import { makeTable, promptSecret, writeStdout } from "../../../../shared/cli-io";
import { commandExists } from "../../../../shared/system";
import {
  ensureDir,
  initializeDataDir,
  loadGlobalConfig,
  loadSecrets,
  resolveDataDir,
  saveGlobalConfig,
  saveSecrets,
} from "../../../../infrastructure/persistence/local-store";

export async function cmdInit(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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

export async function cmdConfig(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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

export async function cmdDoctor(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  assertNoExtraArgs(args, "doctor");

  const checks: Array<{ name: string; ok: boolean; detail: string; required: boolean }> = [];
  const globalConfig = loadGlobalConfig();
  const dataDir = (() => {
    try {
      return resolveDataDir(dataDirOverride);
    } catch {
      return undefined;
    }
  })();

  checks.push({
    name: "global_config",
    ok: Boolean(globalConfig.dataDir),
    detail: globalConfig.dataDir ?? "missing",
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
