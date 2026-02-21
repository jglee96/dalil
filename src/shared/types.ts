export type Mode = "managed" | "attach";
export type SuggestVariant = "concise" | "standard" | "impact";
export type SuggestLang = "ko" | "en";

export interface GlobalConfig {
  schemaVersion: string;
  dataDir?: string;
}

export interface SecretsConfig {
  schemaVersion: string;
  openaiApiKey?: string;
}

export interface CandidateProfile {
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

export interface VaultSource {
  docId: string;
  path: string;
  type: "pdf" | "docx" | "text";
  importedAt: string;
  textSnippet: string;
}

export interface CareerVault {
  schemaVersion: string;
  profile: CandidateProfile;
  sources: VaultSource[];
  version: string;
  updatedAt: string;
}

export interface FieldConstraints {
  maxLength?: number;
  required: boolean;
  pattern?: string;
  languageHint?: string;
}

export interface FormField {
  fieldId: string;
  domPath: string;
  type: string;
  name?: string;
  label: string;
  placeholder?: string;
  hints: string[];
  constraints: FieldConstraints;
}

export interface Citation {
  sourceDocId?: string;
  snippet: string;
}

export interface Suggestion {
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

export interface SuggestionStore {
  schemaVersion: string;
  suggestions: Suggestion[];
}

export interface HistoryFieldEntry {
  label: string;
  constraints: FieldConstraints;
  appliedText: string;
  citations: Citation[];
}

export interface ApplicationHistoryEntry {
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

export interface HistoryStore {
  schemaVersion: string;
  entries: ApplicationHistoryEntry[];
}

export interface RuntimeState {
  schemaVersion: string;
  updatedAt: string;
  fields: FormField[];
}

export interface RunnerConnection {
  schemaVersion: string;
  port: number;
  mode: Mode;
  startedAt: string;
}
