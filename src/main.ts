#!/usr/bin/env node

import { EXIT_USAGE } from "./shared/constants";
import { CliError } from "./shared/errors/cli-error";
import { parseGlobalOptions } from "./shared/cli-args";
import { writeStderr, writeStdout } from "./shared/cli-io";
import {
  cmdFields,
  cmdRevert,
  cmdRun,
} from "./features/runner/interface/cli/runner-commands";
import { cmdSuggest } from "./features/suggest/interface/cli/suggest.command";
import { cmdApply } from "./features/apply/interface/cli/apply.command";
import { cmdHistory } from "./features/history/interface/cli/history.command";
import {
  cmdConfig,
  cmdDoctor,
  cmdInit,
} from "./features/setup/interface/cli/setup-commands";
import { cmdVault } from "./features/vault/interface/cli/vault.command";
import { cmdExport } from "./features/export/interface/cli/export.command";

function printHelp(): void {
  writeStdout("Dalil CLI (MVP v0.1)");
  writeStdout("");
  writeStdout("Runner");
  writeStdout("  dalil runner start [--mode managed|attach] [--cdp <url>] [--port <n>]");
  writeStdout("  dalil runner tui [--mode managed|attach] [--cdp <url>] [--port <n>]");
  writeStdout("  dalil runner fields list [--format table|json]");
  writeStdout("  dalil runner fields show <fieldId>");
  writeStdout("  dalil runner fields highlight <fieldId>");
  writeStdout("  dalil runner revert <fieldId>");
  writeStdout("");
  writeStdout("Setup");
  writeStdout("  dalil setup init --data-dir <path>");
  writeStdout("  dalil setup config set openai.key");
  writeStdout("  dalil setup doctor");
  writeStdout("");
  writeStdout("Data & generation");
  writeStdout("  dalil vault import <file...> [--type resume|portfolio|notes]");
  writeStdout("  dalil vault status");
  writeStdout("  dalil suggest <fieldId> [--variant concise|standard|impact] [--lang ko|en]");
  writeStdout("  dalil suggest --all [--variant ...] [--lang ...]");
  writeStdout("  dalil suggest show <suggestionId> [--with-citations]");
  writeStdout("  dalil apply <fieldId> --suggestion <suggestionId>");
  writeStdout("  dalil apply <fieldId> --text @-");
  writeStdout("  dalil history list [--site <etld+1>] [--limit N]");
  writeStdout("  dalil history show <historyId> [--format text|json]");
  writeStdout("  dalil history search <query>");
  writeStdout("  dalil export resume --lang ko|en --template <id> --out <path.md>");
  writeStdout("  dalil export portfolio --lang ko|en --template <id> --out <path.md>");
}

async function cmdSetup(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const sub = args.shift();
  if (sub === "init") {
    await cmdInit(args, dataDirOverride);
    return;
  }
  if (sub === "config") {
    await cmdConfig(args, dataDirOverride);
    return;
  }
  if (sub === "doctor") {
    await cmdDoctor(args, dataDirOverride);
    return;
  }
  throw new CliError("Usage: dalil setup init|config|doctor ...", EXIT_USAGE);
}

async function cmdRunner(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const sub = args.shift();
  if (sub === "start") {
    if (!args.includes("--daemon")) {
      args.push("--daemon");
    }
    await cmdRun(args, dataDirOverride);
    return;
  }
  if (sub === "tui") {
    await cmdRun(args, dataDirOverride);
    return;
  }
  if (sub === "fields") {
    await cmdFields(args, dataDirOverride);
    return;
  }
  if (sub === "revert") {
    await cmdRevert(args, dataDirOverride);
    return;
  }
  throw new CliError("Usage: dalil runner start|tui|fields|revert ...", EXIT_USAGE);
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
    case "setup":
      await cmdSetup(args, parsed.dataDirOverride);
      return;
    case "runner":
      await cmdRunner(args, parsed.dataDirOverride);
      return;
    case "vault":
      await cmdVault(args, parsed.dataDirOverride);
      return;
    case "suggest":
      await cmdSuggest(args, parsed.dataDirOverride);
      return;
    case "apply":
      await cmdApply(args, parsed.dataDirOverride);
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
