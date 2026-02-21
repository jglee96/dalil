import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { tmpdir } from "node:os";

import { EXIT_INSERTION_BLOCKED, EXIT_USAGE } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import {
  confirm,
  ensureOpenAiConfirmation,
  inferSite,
  nowIso,
  promptLine,
  writeStdout,
} from "../../../../shared/cli-io";
import { commandExists } from "../../../../shared/system";
import { Citation, FormField, SuggestLang, SuggestVariant, Suggestion } from "../../../../shared/types";
import {
  loadHistory,
  loadSecrets,
  loadSuggestions,
  loadVault,
  saveHistory,
  saveSuggestions,
} from "../../../../infrastructure/persistence/local-store";
import {
  callOpenAiSuggestion,
  composeFallbackSuggestion,
  pickRelevantCitations,
} from "../../../suggest/application/suggestion-generator";
import { runnerRequest } from "../http/runner-server";

interface TuiState {
  fields: FormField[];
  selected: number;
  variant: SuggestVariant;
  lang: SuggestLang;
  showCitations: boolean;
  draft: string;
  currentSuggestion?: Suggestion;
  status: string;
  helpOpen: boolean;
  queue: Array<{ fieldId: string; suggestionId?: string; skipped?: boolean }>;
  queueIndex: number;
}

function cycleVariant(variant: SuggestVariant): SuggestVariant {
  if (variant === "concise") {
    return "standard";
  }
  if (variant === "standard") {
    return "impact";
  }
  return "concise";
}

function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  if (max <= 3) {
    return input.slice(0, max);
  }
  return `${input.slice(0, max - 3)}...`;
}

function createDiff(before: string, after: string): string {
  const b = before.replace(/\r\n/g, "\n").split("\n");
  const a = after.replace(/\r\n/g, "\n").split("\n");
  const max = Math.min(Math.max(b.length, a.length), 10);
  const lines: string[] = ["--- current", "+++ draft"];
  for (let i = 0; i < max; i += 1) {
    const left = b[i] ?? "";
    const right = a[i] ?? "";
    if (left === right) {
      lines.push(`  ${left}`);
    } else {
      if (left) {
        lines.push(`- ${left}`);
      }
      if (right) {
        lines.push(`+ ${right}`);
      }
    }
  }
  return lines.join("\n");
}

function render(state: TuiState): void {
  const width = process.stdout.columns ?? 120;
  const height = process.stdout.rows ?? 36;
  const bodyHeight = Math.max(10, height - 6);
  const leftWidth = Math.max(36, Math.floor(width * 0.38));
  const rightWidth = Math.max(40, width - leftWidth - 3);

  const current = state.fields[state.selected];

  const leftLines: string[] = [];
  leftLines.push("Fields");
  leftLines.push("-----");
  if (state.fields.length === 0) {
    leftLines.push("(no fields - press r to rescan)");
  }
  state.fields.slice(0, bodyHeight - 2).forEach((field, idx) => {
    const marker = idx === state.selected ? ">" : " ";
    const label = truncate(field.label || "(unlabeled)", leftWidth - 8);
    const limit = field.constraints.maxLength ? `(${field.constraints.maxLength})` : "";
    leftLines.push(`${marker} ${String(idx + 1).padStart(2, "0")} ${label} ${limit}`.trimEnd());
  });

  const rightLines: string[] = [];
  rightLines.push("Detail");
  rightLines.push("------");
  if (!current) {
    rightLines.push("No selected field");
  } else {
    rightLines.push(`Label: ${truncate(current.label, rightWidth - 7)}`);
    rightLines.push(`Type: ${current.type}`);
    rightLines.push(`Required: ${current.constraints.required ? "yes" : "no"}`);
    rightLines.push(`Max: ${current.constraints.maxLength ?? "-"}  Lang: ${current.constraints.languageHint ?? state.lang}`);
    rightLines.push(`Variant: ${state.variant}  Draft chars: ${state.draft.length}`);
    rightLines.push("");
    rightLines.push("Draft Preview:");
    const preview = state.draft || state.currentSuggestion?.text || "";
    const previewLines = preview.split(/\r?\n/).slice(0, Math.max(3, bodyHeight - 16));
    if (previewLines.length === 0) {
      rightLines.push("(empty)");
    } else {
      for (const line of previewLines) {
        rightLines.push(truncate(line, rightWidth));
      }
    }
    if (state.showCitations && state.currentSuggestion?.citations.length) {
      rightLines.push("");
      rightLines.push("Citations:");
      for (const c of state.currentSuggestion.citations.slice(0, 3)) {
        rightLines.push(`- ${truncate(c.snippet.replace(/\s+/g, " "), rightWidth - 2)}`);
      }
    }
    if (state.queue.length > 0) {
      rightLines.push("");
      rightLines.push(`Queue: ${state.queueIndex + 1}/${state.queue.length}`);
    }
  }

  const maxLines = Math.max(leftLines.length, rightLines.length, bodyHeight);
  process.stdout.write("\x1Bc");
  process.stdout.write("Dalil TUI  |  Dalil fills text only. You submit manually.\n");
  for (let i = 0; i < maxLines; i += 1) {
    const l = (leftLines[i] ?? "").padEnd(leftWidth, " ");
    const r = rightLines[i] ?? "";
    process.stdout.write(`${truncate(l, leftWidth)} | ${truncate(r, rightWidth)}\n`);
  }
  if (state.helpOpen) {
    process.stdout.write("\nKeys: r scan | j/k move | h highlight | s suggest | S suggest all | v variant | l lang | c cite | e edit | d diff | a apply | u undo | y copy | q quit\n");
  } else {
    process.stdout.write("\nKeys: ? help | r/j/k/h/s/S/v/l/c/e/d/a/u/y/q\n");
  }
  process.stdout.write(`Status: ${state.status}\n`);
}

async function withLineMode<T>(fn: () => Promise<T>): Promise<T> {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  try {
    return await fn();
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  }
}

async function generateSuggestion(params: {
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

async function applyDraft(params: {
  dataDir: string;
  field: FormField;
  text: string;
  citations: Citation[];
}): Promise<void> {
  const { dataDir, field, text, citations } = params;
  try {
    await runnerRequest(dataDir, "/set_field_value", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId: field.fieldId, text }),
    });
  } catch {
    try {
      await runnerRequest(dataDir, "/type_into_field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fieldId: field.fieldId, text }),
      });
    } catch {
      throw new CliError(
        `Insertion blocked for ${field.fieldId}. Fallback typing also failed. Copy text manually.`,
        EXIT_INSERTION_BLOCKED,
      );
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
        label: field.label,
        constraints: field.constraints,
        appliedText: text,
        citations,
      },
    ],
  });
  saveHistory(dataDir, history);
}

async function openEditor(initialText: string): Promise<string> {
  const editor = process.env.EDITOR;
  if (!editor) {
    throw new CliError("$EDITOR is not set.", EXIT_USAGE);
  }
  const tempPath = path.join(tmpdir(), `dalil-draft-${Date.now()}.md`);
  fs.writeFileSync(tempPath, initialText, "utf8");
  const result = spawnSync(editor, [tempPath], {
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    throw new CliError(`Editor exited with code ${result.status ?? 1}.`, EXIT_USAGE);
  }
  const edited = fs.readFileSync(tempPath, "utf8");
  fs.rmSync(tempPath, { force: true });
  return edited;
}

function copyToClipboard(text: string): boolean {
  if (commandExists("pbcopy")) {
    const result = spawnSync("pbcopy", { input: text, encoding: "utf8" });
    return result.status === 0;
  }
  return false;
}

export async function runInteractiveTui(dataDir: string): Promise<void> {
  const state: TuiState = {
    fields: [],
    selected: 0,
    variant: "standard",
    lang: "ko",
    showCitations: false,
    draft: "",
    status: "Press r to scan fields.",
    helpOpen: false,
    queue: [],
    queueIndex: 0,
  };

  const scan = async (): Promise<void> => {
    const payload = await runnerRequest<{ fields: FormField[] }>(dataDir, "/scan_fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    state.fields = payload.fields;
    if (state.fields.length === 0) {
      state.selected = 0;
      state.status = "No fields found on current page.";
      state.currentSuggestion = undefined;
      state.draft = "";
      return;
    }
    state.selected = Math.min(state.selected, state.fields.length - 1);
    state.status = `Scanned ${state.fields.length} fields.`;
  };

  const currentField = (): FormField | undefined => state.fields[state.selected];

  const gotoFieldById = (fieldId: string): void => {
    const idx = state.fields.findIndex((f) => f.fieldId === fieldId);
    if (idx >= 0) {
      state.selected = idx;
    }
  };

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  let busy = false;
  let running = true;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (): void => {
    running = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeListener("keypress", onKeypress);
    resolveDone?.();
  };

  const onKeypress = async (_str: string, key: readline.Key): Promise<void> => {
    if (!running || busy) {
      return;
    }
    busy = true;
    try {
      if (key.ctrl && key.name === "r") {
        render(state);
        return;
      }
      if (key.name === "q") {
        const shouldQuit = await withLineMode(async () => confirm("Quit TUI?", true));
        if (shouldQuit) {
          finish();
        }
        return;
      }
      if (key.name === "?") {
        state.helpOpen = !state.helpOpen;
        return;
      }
      if (key.name === "r") {
        await scan();
        return;
      }
      if (key.name === "j" || key.name === "down") {
        if (state.fields.length > 0) {
          state.selected = Math.min(state.selected + 1, state.fields.length - 1);
        }
        return;
      }
      if (key.name === "k" || key.name === "up") {
        if (state.fields.length > 0) {
          state.selected = Math.max(state.selected - 1, 0);
        }
        return;
      }
      if (key.name === "g") {
        state.selected = 0;
        return;
      }
      if (_str === "G") {
        state.selected = Math.max(0, state.fields.length - 1);
        return;
      }

      const field = currentField();
      if (!field) {
        state.status = "No selected field.";
        return;
      }

      if (key.name === "h") {
        await runnerRequest(dataDir, "/highlight_field", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fieldId: field.fieldId }),
        });
        state.status = `Highlighted: ${field.label}`;
        return;
      }
      if (key.name === "v") {
        state.variant = cycleVariant(state.variant);
        state.status = `Variant: ${state.variant}`;
        return;
      }
      if (key.name === "l") {
        state.lang = state.lang === "ko" ? "en" : "ko";
        state.status = `Language: ${state.lang}`;
        return;
      }
      if (key.name === "c") {
        state.showCitations = !state.showCitations;
        return;
      }
      if (key.name === "p") {
        const vault = loadVault(dataDir);
        const preview = {
          field: {
            label: field.label,
            hints: field.hints,
            constraints: field.constraints,
          },
          profile_excerpt: {
            headline: vault.profile.headline,
            skills: vault.profile.skills.slice(0, 8),
            experience: vault.profile.experience.slice(0, 5),
          },
          variant: state.variant,
          lang: state.lang,
        };
        await withLineMode(async () => {
          writeStdout(JSON.stringify(preview, null, 2));
          await promptLine("Press Enter to continue...");
        });
        state.status = "Displayed request preview.";
        return;
      }
      if (key.name === "s") {
        const suggestion = await withLineMode(async () =>
          generateSuggestion({
            dataDir,
            field,
            variant: state.variant,
            lang: state.lang,
          }),
        );
        state.currentSuggestion = suggestion;
        state.draft = suggestion.text;
        state.status = `Generated suggestion ${suggestion.suggestionId.slice(0, 8)}...`;
        return;
      }
      if (_str === "S") {
        state.queue = [];
        state.queueIndex = 0;
        for (const f of state.fields) {
          const suggestion = await withLineMode(async () =>
            generateSuggestion({
              dataDir,
              field: f,
              variant: state.variant,
              lang: state.lang,
            }),
          );
          state.queue.push({ fieldId: f.fieldId, suggestionId: suggestion.suggestionId });
          if (f.fieldId === field.fieldId) {
            state.currentSuggestion = suggestion;
            state.draft = suggestion.text;
          }
        }
        state.status = `Generated queue for ${state.queue.length} fields.`;
        return;
      }
      if (key.name === "n") {
        if (state.queue.length === 0) {
          state.status = "Queue is empty.";
          return;
        }
        state.queueIndex = Math.min(state.queueIndex + 1, state.queue.length - 1);
        gotoFieldById(state.queue[state.queueIndex].fieldId);
        state.status = `Queue ${state.queueIndex + 1}/${state.queue.length}`;
        return;
      }
      if (key.name === "b") {
        if (state.queue.length === 0) {
          state.status = "Queue is empty.";
          return;
        }
        state.queueIndex = Math.max(state.queueIndex - 1, 0);
        gotoFieldById(state.queue[state.queueIndex].fieldId);
        state.status = `Queue ${state.queueIndex + 1}/${state.queue.length}`;
        return;
      }
      if (key.name === "x") {
        if (state.queue.length === 0) {
          state.status = "Queue is empty.";
          return;
        }
        state.queue[state.queueIndex].skipped = true;
        state.status = `Skipped queue item ${state.queueIndex + 1}.`;
        return;
      }
      if (key.name === "e") {
        const baseText = state.draft || state.currentSuggestion?.text || "";
        const edited = await withLineMode(async () => openEditor(baseText));
        state.draft = edited;
        state.status = "Draft updated from editor.";
        return;
      }
      if (key.name === "y") {
        const copied = copyToClipboard(state.draft || state.currentSuggestion?.text || "");
        state.status = copied ? "Copied draft to clipboard." : "Clipboard unavailable (install pbcopy).";
        return;
      }
      if (key.name === "d") {
        const valuePayload = await runnerRequest<{ value: string }>(dataDir, "/read_field_value", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fieldId: field.fieldId }),
        });
        const diff = createDiff(valuePayload.value ?? "", state.draft || state.currentSuggestion?.text || "");
        await withLineMode(async () => {
          writeStdout(diff);
          await promptLine("Press Enter to continue...");
        });
        state.status = "Displayed diff.";
        return;
      }
      if (key.name === "a") {
        const text = state.draft || state.currentSuggestion?.text || "";
        if (!text) {
          state.status = "No draft to apply.";
          return;
        }
        const ok = await withLineMode(async () => confirm(`Apply to ${field.label}?`, true));
        if (!ok) {
          state.status = "Apply cancelled.";
          return;
        }
        await applyDraft({
          dataDir,
          field,
          text,
          citations: state.currentSuggestion?.citations ?? [],
        });
        state.status = `Applied text to ${field.label}.`;
        return;
      }
      if (key.name === "u") {
        await runnerRequest(dataDir, "/revert_field", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fieldId: field.fieldId }),
        });
        state.status = `Reverted ${field.label}.`;
        return;
      }
    } catch (err) {
      state.status = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      if (running) {
        render(state);
      }
    }
  };

  process.stdin.on("keypress", onKeypress);

  try {
    await scan();
    render(state);
    await done;
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeListener("keypress", onKeypress);
  }
}
