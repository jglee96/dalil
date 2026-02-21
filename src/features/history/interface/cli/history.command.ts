import { EXIT_USAGE, SCHEMA_VERSION } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { assertNoExtraArgs, takeFlag, takeOption } from "../../../../shared/cli-args";
import { makeTable, writeStdout } from "../../../../shared/cli-io";
import {
  initializeDataDir,
  loadHistory,
  resolveDataDir,
} from "../../../../infrastructure/persistence/local-store";

export async function cmdHistory(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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
