#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { Writable } from "node:stream";

const SCHEMA_VERSION = "0.1.0";
const RUNNER_DEFAULT_PORT = 48777;

const EXIT_USAGE = 2;
const EXIT_ENV = 3;
const EXIT_OPENAI = 4;
const EXIT_INSERTION_BLOCKED = 5;

type Mode = "managed" | "attach";
type SuggestVariant = "concise" | "standard" | "impact";
type SuggestLang = "ko" | "en";

interface GlobalConfig {
  schemaVersion: string;
  dataDir?: string;
}

interface SecretsConfig {
  schemaVersion: string;
  openaiApiKey?: string;
}

interface CandidateProfile {
  identity: {
    name?: string;
    email?: string;
  };
  headline?: string;
  experience: string[];
  projects: string[];
  skills: string[];
  education: string[];
  links: string[];
}

interface VaultSource {
  docId: string;
  path: string;
  type: "pdf" | "docx" | "text";
  importedAt: string;
  textSnippet: string;
}

interface CareerVault {
  schemaVersion: string;
  profile: CandidateProfile;
  sources: VaultSource[];
  version: string;
  updatedAt: string;
}

interface FieldConstraints {
  maxLength?: number;
  required: boolean;
  pattern?: string;
  languageHint?: string;
}

interface FormField {
  fieldId: string;
  domPath: string;
  type: string;
  name?: string;
  label: string;
  placeholder?: string;
  hints: string[];
  constraints: FieldConstraints;
}

interface Citation {
  sourceDocId?: string;
  snippet: string;
}

interface Suggestion {
  suggestionId: string;
  createdAt: string;
  fieldId: string;
  text: string;
  variant: SuggestVariant;
  lang: SuggestLang;
  citations: Citation[];
  confidence: "low" | "medium" | "high";
  needsConfirmation: boolean;
}

interface SuggestionStore {
  schemaVersion: string;
  suggestions: Suggestion[];
}

interface HistoryFieldEntry {
  label: string;
  constraints: FieldConstraints;
  appliedText: string;
  citations: Citation[];
}

interface ApplicationHistoryEntry {
  id: string;
  createdAt: string;
  site: {
    etldPlusOne?: string;
    hostname?: string;
  };
  page: {
    url?: string;
    title?: string;
  };
  fields: HistoryFieldEntry[];
  notes?: string;
}

interface HistoryStore {
  schemaVersion: string;
  entries: ApplicationHistoryEntry[];
}

interface RuntimeState {
  schemaVersion: string;
  updatedAt: string;
  fields: FormField[];
}

interface RunnerConnection {
  schemaVersion: string;
  port: number;
  mode: Mode;
  startedAt: string;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function parseGlobalOptions(argv: string[]): { args: string[]; dataDirOverride?: string } {
  const args: string[] = [];
  let dataDirOverride: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--data-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError("`--data-dir` requires a path.", EXIT_USAGE);
      }
      dataDirOverride = path.resolve(value);
      i += 1;
      continue;
    }
    args.push(token);
  }
  return { args, dataDirOverride };
}

function takeOption(args: string[], option: string): string | undefined {
  const idx = args.indexOf(option);
  if (idx < 0) {
    return undefined;
  }
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new CliError(`\`${option}\` requires a value.`, EXIT_USAGE);
  }
  args.splice(idx, 2);
  return value;
}

function takeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx < 0) {
    return false;
  }
  args.splice(idx, 1);
  return true;
}

function assertNoExtraArgs(args: string[], context: string): void {
  if (args.length > 0) {
    throw new CliError(`Unexpected arguments for ${context}: ${args.join(" ")}`, EXIT_USAGE);
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return fallback;
  }
  return JSON.parse(raw) as T;
}

function writeJsonFile(filePath: string, payload: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function resolveGlobalConfigDir(): string {
  if (process.env.DALIL_CONFIG_HOME) {
    const custom = path.resolve(process.env.DALIL_CONFIG_HOME);
    ensureDir(custom);
    return custom;
  }
  const preferred = path.join(homedir(), ".dalil");
  try {
    ensureDir(preferred);
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.resolve(process.cwd(), ".dalil-global");
    ensureDir(fallback);
    return fallback;
  }
}

function globalConfigPath(): string {
  return path.join(resolveGlobalConfigDir(), "config.json");
}

function defaultGlobalConfig(): GlobalConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
  };
}

function loadGlobalConfig(): GlobalConfig {
  return readJsonFile<GlobalConfig>(globalConfigPath(), defaultGlobalConfig());
}

function saveGlobalConfig(config: GlobalConfig): void {
  writeJsonFile(globalConfigPath(), config);
}

function resolveDataDir(dataDirOverride?: string): string {
  if (dataDirOverride) {
    return path.resolve(dataDirOverride);
  }
  const config = loadGlobalConfig();
  if (!config.dataDir) {
    throw new CliError(
      "Data directory is not configured. Run `dalil init --data-dir <path>` first.",
      EXIT_ENV,
    );
  }
  return path.resolve(config.dataDir);
}

function pathInDataDir(dataDir: string, ...segments: string[]): string {
  return path.join(dataDir, ...segments);
}

function secretsPath(dataDir: string): string {
  return pathInDataDir(dataDir, "secrets.json");
}

function vaultPath(dataDir: string): string {
  return pathInDataDir(dataDir, "vault.json");
}

function historyPath(dataDir: string): string {
  return pathInDataDir(dataDir, "history.json");
}

function suggestionsPath(dataDir: string): string {
  return pathInDataDir(dataDir, "suggestions.json");
}

function runtimeStatePath(dataDir: string): string {
  return pathInDataDir(dataDir, "runtime", "fields.json");
}

function runnerConnectionPath(dataDir: string): string {
  return pathInDataDir(dataDir, "runtime", "runner.json");
}

function defaultProfile(): CandidateProfile {
  return {
    identity: {},
    experience: [],
    projects: [],
    skills: [],
    education: [],
    links: [],
  };
}

function defaultVault(): CareerVault {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: defaultProfile(),
    sources: [],
    version: "0.1.0",
    updatedAt: nowIso(),
  };
}

function defaultHistory(): HistoryStore {
  return {
    schemaVersion: SCHEMA_VERSION,
    entries: [],
  };
}

function defaultSuggestions(): SuggestionStore {
  return {
    schemaVersion: SCHEMA_VERSION,
    suggestions: [],
  };
}

function defaultRuntimeState(): RuntimeState {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso(),
    fields: [],
  };
}

function defaultSecrets(): SecretsConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
  };
}

function initializeDataDir(dataDir: string): void {
  ensureDir(dataDir);
  ensureDir(path.join(dataDir, "runtime"));
  if (!fs.existsSync(vaultPath(dataDir))) {
    writeJsonFile(vaultPath(dataDir), defaultVault());
  }
  if (!fs.existsSync(historyPath(dataDir))) {
    writeJsonFile(historyPath(dataDir), defaultHistory());
  }
  if (!fs.existsSync(suggestionsPath(dataDir))) {
    writeJsonFile(suggestionsPath(dataDir), defaultSuggestions());
  }
  if (!fs.existsSync(runtimeStatePath(dataDir))) {
    writeJsonFile(runtimeStatePath(dataDir), defaultRuntimeState());
  }
  if (!fs.existsSync(secretsPath(dataDir))) {
    writeJsonFile(secretsPath(dataDir), defaultSecrets());
  }
}

function loadVault(dataDir: string): CareerVault {
  return readJsonFile<CareerVault>(vaultPath(dataDir), defaultVault());
}

function saveVault(dataDir: string, vault: CareerVault): void {
  vault.updatedAt = nowIso();
  writeJsonFile(vaultPath(dataDir), vault);
}

function loadHistory(dataDir: string): HistoryStore {
  return readJsonFile<HistoryStore>(historyPath(dataDir), defaultHistory());
}

function saveHistory(dataDir: string, history: HistoryStore): void {
  writeJsonFile(historyPath(dataDir), history);
}

function loadSuggestions(dataDir: string): SuggestionStore {
  return readJsonFile<SuggestionStore>(suggestionsPath(dataDir), defaultSuggestions());
}

function saveSuggestions(dataDir: string, suggestions: SuggestionStore): void {
  writeJsonFile(suggestionsPath(dataDir), suggestions);
}

function loadRuntimeState(dataDir: string): RuntimeState {
  return readJsonFile<RuntimeState>(runtimeStatePath(dataDir), defaultRuntimeState());
}

function saveRuntimeState(dataDir: string, state: RuntimeState): void {
  state.updatedAt = nowIso();
  writeJsonFile(runtimeStatePath(dataDir), state);
}

function loadSecrets(dataDir: string): SecretsConfig {
  return readJsonFile<SecretsConfig>(secretsPath(dataDir), defaultSecrets());
}

function saveSecrets(dataDir: string, secrets: SecretsConfig): void {
  writeJsonFile(secretsPath(dataDir), secrets);
}

function commandExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { stdio: "ignore" });
  return result.status === 0;
}

function makeTable(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx] ?? 0, cell.length);
    });
  }
  const lines = rows.map((row, rowIdx) => {
    const padded = row.map((cell, idx) => cell.padEnd(widths[idx], " "));
    const line = padded.join("  ");
    if (rowIdx === 0) {
      const sep = widths.map((w) => "-".repeat(w)).join("  ");
      return `${line}\n${sep}`;
    }
    return line;
  });
  return lines.join("\n");
}

function redactValue(value: string): string {
  if (!value) {
    return "";
  }
  const email = value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
  return email.replace(/\b\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, "[redacted-phone]");
}

function inferSite(url?: string): { hostname?: string; etldPlusOne?: string } {
  if (!url) {
    return {};
  }
  try {
    const parsed = new URL(url);
    const hostParts = parsed.hostname.split(".");
    if (hostParts.length >= 2) {
      const etldPlusOne = `${hostParts[hostParts.length - 2]}.${hostParts[hostParts.length - 1]}`;
      return { hostname: parsed.hostname, etldPlusOne };
    }
    return { hostname: parsed.hostname };
  } catch {
    return {};
  }
}

class MutableStdout extends Writable {
  muted = false;

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) {
      process.stdout.write(chunk, encoding);
    }
    callback();
  }
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError("Secret input requires a TTY.", EXIT_ENV);
  }
  const mutable = new MutableStdout();
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutable,
    terminal: true,
  });
  mutable.muted = false;
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    mutable.muted = true;
  });
}

async function confirm(question: string, defaultNo = true): Promise<boolean> {
  const raw = (await promptLine(`${question} ${defaultNo ? "(y/N)" : "(Y/n)"} `)).toLowerCase();
  if (!raw) {
    return !defaultNo;
  }
  return raw === "y" || raw === "yes";
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractProfileFromSources(sources: VaultSource[]): CandidateProfile {
  const profile = defaultProfile();
  const allText = sources.map((s) => s.textSnippet).join("\n");
  const lines = allText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const emailMatch = allText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch) {
    profile.identity.email = emailMatch[0];
  }

  const headline = lines.find((line) => line.length >= 8 && line.length <= 120);
  if (headline) {
    profile.headline = headline;
  }

  const skills = new Set<string>();
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("skills") || line.startsWith("기술")) {
      for (const token of line.split(/[,:/|]/)) {
        const cleaned = token.replace(/skills?/i, "").trim();
        if (cleaned.length >= 2 && cleaned.length <= 24) {
          skills.add(cleaned);
        }
      }
    }
  }
  profile.skills = Array.from(skills).slice(0, 30);

  profile.experience = lines
    .filter((line) => /^[-•*]/.test(line) || /회사|company|engineer|개발|project|성과/i.test(line))
    .slice(0, 25);

  profile.projects = lines.filter((line) => /project|프로젝트/i.test(line)).slice(0, 20);
  profile.education = lines.filter((line) => /대학교|university|college|학사|석사|phd/i.test(line)).slice(0, 10);
  profile.links = lines.filter((line) => /^https?:\/\//.test(line)).slice(0, 10);

  return profile;
}

function detectSourceType(filePath: string, forcedType?: "resume" | "portfolio" | "notes"): "pdf" | "docx" | "text" {
  if (forcedType === "notes") {
    return "text";
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    return "pdf";
  }
  if (ext === ".docx") {
    return "docx";
  }
  return "text";
}

function extractTextFromFile(filePath: string, sourceType: "pdf" | "docx" | "text"): string {
  if (!fs.existsSync(filePath)) {
    throw new CliError(`File not found: ${filePath}`, EXIT_USAGE);
  }
  if (sourceType === "text") {
    return normalizeWhitespace(fs.readFileSync(filePath, "utf8"));
  }
  if (sourceType === "docx") {
    if (!commandExists("textutil")) {
      return "";
    }
    const result = spawnSync("textutil", ["-convert", "txt", "-stdout", filePath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status === 0) {
      return normalizeWhitespace(result.stdout ?? "");
    }
    return "";
  }
  if (sourceType === "pdf") {
    if (commandExists("pdftotext")) {
      const result = spawnSync("pdftotext", [filePath, "-"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.status === 0) {
        return normalizeWhitespace(result.stdout ?? "");
      }
    }
    return "";
  }
  return "";
}

function pickRelevantCitations(vault: CareerVault, field: FormField): Citation[] {
  const queryTokens = `${field.label} ${field.hints.join(" ")}`
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);

  const scored = vault.sources.map((source) => {
    const lower = source.textSnippet.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (lower.includes(token)) {
        score += 1;
      }
    }
    return { source, score };
  });

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ source }) => ({
      sourceDocId: source.docId,
      snippet: source.textSnippet.slice(0, 260),
    }));

  return selected.filter((c) => c.snippet.length > 0);
}

function composeFallbackSuggestion(
  field: FormField,
  profile: CandidateProfile,
  variant: SuggestVariant,
  lang: SuggestLang,
): { text: string; needsConfirmation: boolean; confidence: "low" | "medium" | "high" } {
  const head = profile.headline ?? (lang === "ko" ? "지원 직무와 관련된 경험을 보유하고 있습니다." : "I have relevant experience for this role.");
  const focus = profile.experience[0] ?? profile.projects[0] ?? "";
  const skills = profile.skills.slice(0, variant === "concise" ? 3 : 6).join(", ");
  const cap = field.constraints.maxLength;

  let text = "";
  if (lang === "ko") {
    text = `${head} ${focus} ${skills ? `주요 기술: ${skills}.` : ""}`.trim();
  } else {
    text = `${head} ${focus} ${skills ? `Key skills: ${skills}.` : ""}`.trim();
  }

  if (!focus) {
    text += lang === "ko" ? " [TODO: 구체 프로젝트/성과를 입력하세요]" : " [TODO: add project scope and impact]";
  }
  if (cap && text.length > cap) {
    text = text.slice(0, Math.max(0, cap - 1));
  }
  return {
    text,
    needsConfirmation: !focus,
    confidence: focus ? "medium" : "low",
  };
}

interface OpenAISuggestionResult {
  text: string;
  needsConfirmation: boolean;
  confidence: "low" | "medium" | "high";
}

async function callOpenAiSuggestion(params: {
  apiKey: string;
  field: FormField;
  profile: CandidateProfile;
  citations: Citation[];
  variant: SuggestVariant;
  lang: SuggestLang;
}): Promise<OpenAISuggestionResult> {
  const model = process.env.DALIL_OPENAI_MODEL ?? "gpt-4o-mini";
  const systemPrompt = [
    "You are Dalil, a serious and truthful assistant for job application form writing.",
    "Rules:",
    "1) Do not fabricate facts.",
    "2) Respect max length and language.",
    "3) Use only profile/citation facts.",
    "4) If facts are missing, include [TODO: ...].",
    "Respond as strict JSON with keys: text, needs_confirmation, confidence.",
    "confidence must be one of low, medium, high.",
  ].join("\n");
  const userPayload = {
    field: {
      label: params.field.label,
      hints: params.field.hints,
      constraints: params.field.constraints,
      placeholder: params.field.placeholder,
    },
    profile: params.profile,
    citations: params.citations,
    variant: params.variant,
    lang: params.lang,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 500,
      input: [
        {
          role: "system",
          content: [{ type: "text", text: systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "text", text: JSON.stringify(userPayload) }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new CliError(`OpenAI request failed: ${response.status} ${detail}`, EXIT_OPENAI);
  }
  const data = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };

  let rawText = (data.output_text ?? "").trim();
  if (!rawText) {
    const contentText = data.output?.[0]?.content?.find((item) => item.type === "output_text" || item.type === "text")?.text;
    rawText = (contentText ?? "").trim();
  }
  if (!rawText) {
    throw new CliError("OpenAI returned empty output.", EXIT_OPENAI);
  }

  let parsed: { text?: string; needs_confirmation?: boolean; confidence?: string } | undefined;
  try {
    parsed = JSON.parse(rawText) as { text?: string; needs_confirmation?: boolean; confidence?: string };
  } catch {
    parsed = undefined;
  }

  const text = (parsed?.text ?? rawText).trim();
  const needsConfirmation = parsed?.needs_confirmation ?? text.includes("[TODO:");
  const confidence = parsed?.confidence === "low" || parsed?.confidence === "high" ? parsed.confidence : "medium";

  let finalText = text;
  const cap = params.field.constraints.maxLength;
  if (cap && finalText.length > cap) {
    finalText = finalText.slice(0, Math.max(cap - 1, 0));
  }

  return {
    text: finalText,
    needsConfirmation: needsConfirmation || params.citations.length === 0,
    confidence,
  };
}

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
  const conn = readJsonFile<RunnerConnection | null>(runnerConnectionPath(dataDir), null);
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

async function ensureOpenAiConfirmation(preview: unknown): Promise<void> {
  writeStdout("Request preview:");
  writeStdout(JSON.stringify(preview, null, 2));
  if (process.env.DALIL_CONFIRM_OPENAI === "1") {
    return;
  }
  if (!process.stdin.isTTY) {
    throw new CliError(
      "OpenAI call confirmation requires a TTY. Set DALIL_CONFIRM_OPENAI=1 for non-interactive runs.",
      EXIT_ENV,
    );
  }
  const ok = await confirm("Send to OpenAI?", true);
  if (!ok) {
    throw new CliError("Cancelled by user.", EXIT_USAGE);
  }
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
  writeJsonFile(runnerConnectionPath(dataDir), conn);

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

function composeExportMarkdown(
  vault: CareerVault,
  artifact: "resume" | "portfolio",
  lang: SuggestLang,
  template: string,
): string {
  const lines: string[] = [];
  lines.push(`# Dalil ${artifact === "resume" ? "Resume" : "Portfolio"}`);
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- Template: ${template}`);
  lines.push(`- Language: ${lang}`);
  lines.push("");

  if (vault.profile.identity.name) {
    lines.push(`## ${vault.profile.identity.name}`);
  }
  if (vault.profile.identity.email) {
    lines.push(vault.profile.identity.email);
  }
  if (vault.profile.headline) {
    lines.push("");
    lines.push(vault.profile.headline);
  }

  if (vault.profile.experience.length > 0) {
    lines.push("");
    lines.push(`## ${lang === "ko" ? "경력" : "Experience"}`);
    for (const item of vault.profile.experience) {
      lines.push(`- ${item.replace(/^[-•*\s]+/, "")}`);
    }
  }
  if (vault.profile.projects.length > 0) {
    lines.push("");
    lines.push(`## ${lang === "ko" ? "프로젝트" : "Projects"}`);
    for (const item of vault.profile.projects) {
      lines.push(`- ${item.replace(/^[-•*\s]+/, "")}`);
    }
  }
  if (vault.profile.skills.length > 0) {
    lines.push("");
    lines.push(`## ${lang === "ko" ? "기술 스택" : "Skills"}`);
    lines.push(vault.profile.skills.join(", "));
  }
  if (vault.profile.education.length > 0) {
    lines.push("");
    lines.push(`## ${lang === "ko" ? "학력" : "Education"}`);
    for (const item of vault.profile.education) {
      lines.push(`- ${item.replace(/^[-•*\s]+/, "")}`);
    }
  }
  if (vault.profile.links.length > 0) {
    lines.push("");
    lines.push("## Links");
    for (const link of vault.profile.links) {
      lines.push(`- ${link}`);
    }
  }
  return lines.join("\n");
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
  const outPath = path.resolve(outPathRaw);
  ensureDir(path.dirname(outPath));
  const ext = path.extname(outPath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") {
    throw new CliError("Markdown export only: use `--out <path.md>`.", EXIT_USAGE);
  }
  const content = composeExportMarkdown(vault, artifact, lang, template);
  fs.writeFileSync(outPath, content, "utf8");

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
