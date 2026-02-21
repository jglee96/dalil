import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { SCHEMA_VERSION, EXIT_ENV } from "../../shared/constants";
import { CliError } from "../../shared/errors/cli-error";
import { nowIso } from "../../shared/cli-io";
import {
  CandidateProfile,
  CareerVault,
  GlobalConfig,
  HistoryStore,
  RunnerConnection,
  RuntimeState,
  SecretsConfig,
  SuggestionStore,
} from "../../shared/types";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return fallback;
  }
  return JSON.parse(raw) as T;
}

export function writeJsonFile(filePath: string, payload: unknown): void {
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

export function loadGlobalConfig(): GlobalConfig {
  return readJsonFile<GlobalConfig>(globalConfigPath(), defaultGlobalConfig());
}

export function saveGlobalConfig(config: GlobalConfig): void {
  writeJsonFile(globalConfigPath(), config);
}

export function resolveDataDir(dataDirOverride?: string): string {
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

export function pathInDataDir(dataDir: string, ...segments: string[]): string {
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

export function runnerConnectionPath(dataDir: string): string {
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

export function initializeDataDir(dataDir: string): void {
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

export function loadVault(dataDir: string): CareerVault {
  return readJsonFile<CareerVault>(vaultPath(dataDir), defaultVault());
}

export function saveVault(dataDir: string, vault: CareerVault): void {
  vault.updatedAt = nowIso();
  writeJsonFile(vaultPath(dataDir), vault);
}

export function loadHistory(dataDir: string): HistoryStore {
  return readJsonFile<HistoryStore>(historyPath(dataDir), defaultHistory());
}

export function saveHistory(dataDir: string, history: HistoryStore): void {
  writeJsonFile(historyPath(dataDir), history);
}

export function loadSuggestions(dataDir: string): SuggestionStore {
  return readJsonFile<SuggestionStore>(suggestionsPath(dataDir), defaultSuggestions());
}

export function saveSuggestions(dataDir: string, suggestions: SuggestionStore): void {
  writeJsonFile(suggestionsPath(dataDir), suggestions);
}

export function loadRuntimeState(dataDir: string): RuntimeState {
  return readJsonFile<RuntimeState>(runtimeStatePath(dataDir), defaultRuntimeState());
}

export function saveRuntimeState(dataDir: string, state: RuntimeState): void {
  state.updatedAt = nowIso();
  writeJsonFile(runtimeStatePath(dataDir), state);
}

export function loadSecrets(dataDir: string): SecretsConfig {
  return readJsonFile<SecretsConfig>(secretsPath(dataDir), defaultSecrets());
}

export function saveSecrets(dataDir: string, secrets: SecretsConfig): void {
  writeJsonFile(secretsPath(dataDir), secrets);
}

export function loadRunnerConnection(dataDir: string): RunnerConnection | null {
  return readJsonFile<RunnerConnection | null>(runnerConnectionPath(dataDir), null);
}

export function saveRunnerConnection(dataDir: string, conn: RunnerConnection): void {
  writeJsonFile(runnerConnectionPath(dataDir), conn);
}
