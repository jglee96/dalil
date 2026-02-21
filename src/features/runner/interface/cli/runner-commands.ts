import fs from "node:fs";

import { EXIT_USAGE, RUNNER_DEFAULT_PORT, SCHEMA_VERSION } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { assertNoExtraArgs, takeFlag, takeOption } from "../../../../shared/cli-args";
import { makeTable, nowIso, redactValue, writeStdout } from "../../../../shared/cli-io";
import { FormField, Mode, RunnerConnection } from "../../../../shared/types";
import {
  initializeDataDir,
  resolveDataDir,
  runnerConnectionPath,
  saveRunnerConnection,
} from "../../../../infrastructure/persistence/local-store";
import { runnerRequest, startRunnerServer } from "../http/runner-server";
import { runInteractiveTui } from "./run-tui";

export async function cmdRun(rawArgs: string[], dataDirOverride?: string): Promise<void> {
  const args = [...rawArgs];
  const daemon = takeFlag(args, "--daemon");
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
  if (!daemon && process.stdin.isTTY) {
    writeStdout("Launching interactive TUI...");
  } else {
    writeStdout("Keep this process running and use another terminal for CLI commands.");
  }

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

  if (!daemon && process.stdin.isTTY) {
    try {
      await runInteractiveTui(dataDir);
    } finally {
      await stop();
    }
    return;
  }

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

export async function cmdFields(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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

export async function cmdRevert(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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
