import { EXIT_OPENAI } from "../../../shared/constants";
import { CliError } from "../../../shared/errors/cli-error";
import {
  CandidateProfile,
  CareerVault,
  Citation,
  FormField,
  SuggestLang,
  SuggestVariant,
} from "../../../shared/types";

export interface OpenAISuggestionResult {
  text: string;
  needsConfirmation: boolean;
  confidence: "low" | "medium" | "high";
}

export function pickRelevantCitations(vault: CareerVault, field: FormField): Citation[] {
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

export function composeFallbackSuggestion(
  field: FormField,
  profile: CandidateProfile,
  variant: SuggestVariant,
  lang: SuggestLang,
): OpenAISuggestionResult {
  const head =
    profile.headline ??
    (lang === "ko" ? "지원 직무와 관련된 경험을 보유하고 있습니다." : "I have relevant experience for this role.");
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

export async function callOpenAiSuggestion(params: {
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
