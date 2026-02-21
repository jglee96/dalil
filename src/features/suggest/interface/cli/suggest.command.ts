import { randomUUID } from "node:crypto";

import { EXIT_USAGE, SCHEMA_VERSION } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { assertNoExtraArgs, takeFlag, takeOption } from "../../../../shared/cli-args";
import { ensureOpenAiConfirmation, makeTable, nowIso, writeStdout } from "../../../../shared/cli-io";
import { FormField, SuggestLang, SuggestVariant, Suggestion } from "../../../../shared/types";
import {
  initializeDataDir,
  loadSecrets,
  loadSuggestions,
  loadVault,
  resolveDataDir,
  saveSuggestions,
} from "../../../../infrastructure/persistence/local-store";
import { runnerRequest } from "../../../runner";
import {
  callOpenAiSuggestion,
  composeFallbackSuggestion,
  pickRelevantCitations,
} from "../../application/suggestion-generator";

async function generateSuggestionForField(params: {
  dataDir: string;
  field: FormField;
  variant: SuggestVariant;
  lang: SuggestLang;
}): Promise<Suggestion> {
  const vault = loadVault(params.dataDir);
  const secrets = loadSecrets(params.dataDir);
  const citations = pickRelevantCitations(vault, params.field);

  let result;
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

export async function cmdSuggest(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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
