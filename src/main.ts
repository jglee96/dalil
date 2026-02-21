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
      await cmdDoctor(args, parsed.dataDirOverride);
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
