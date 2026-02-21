import fs from "node:fs";
import path from "node:path";

import { EXIT_USAGE } from "../../../shared/constants";
import { CliError } from "../../../shared/errors/cli-error";
import { CareerVault, SuggestLang } from "../../../shared/types";
import { ensureDir } from "../../../infrastructure/persistence/local-store";

export function composeExportMarkdown(
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

export function exportMarkdownFile(outPathRaw: string, content: string): string {
  const outPath = path.resolve(outPathRaw);
  const ext = path.extname(outPath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") {
    throw new CliError("Markdown export only: use `--out <path.md>`.", EXIT_USAGE);
  }
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, content, "utf8");
  return outPath;
}
