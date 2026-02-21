import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { EXIT_USAGE } from "../../../shared/constants";
import { CliError } from "../../../shared/errors/cli-error";
import { commandExists, normalizeWhitespace } from "../../../shared/system";
import { CandidateProfile, VaultSource } from "../../../shared/types";

export function defaultProfile(): CandidateProfile {
  return {
    identity: {},
    experience: [],
    projects: [],
    skills: [],
    education: [],
    links: [],
  };
}

export function extractProfileFromSources(sources: VaultSource[]): CandidateProfile {
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

export function detectSourceType(filePath: string, forcedType?: "resume" | "portfolio" | "notes"): "pdf" | "docx" | "text" {
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

export function extractTextFromFile(filePath: string, sourceType: "pdf" | "docx" | "text"): string {
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
