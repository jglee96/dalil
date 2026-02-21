import { randomUUID } from "node:crypto";

import { EXIT_INSERTION_BLOCKED, EXIT_USAGE } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { assertNoExtraArgs, takeOption } from "../../../../shared/cli-args";
import { inferSite, nowIso, readStdinText, writeStderr, writeStdout } from "../../../../shared/cli-io";
import { Citation, FormField } from "../../../../shared/types";
import {
  initializeDataDir,
  loadHistory,
  loadSuggestions,
  resolveDataDir,
  saveHistory,
} from "../../../../infrastructure/persistence/local-store";
import { runnerRequest } from "../../../runner/interface/http/runner-server";

export async function cmdApply(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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
