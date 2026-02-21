import { randomUUID } from "node:crypto";
import path from "node:path";

import { EXIT_USAGE } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { assertNoExtraArgs, takeOption } from "../../../../shared/cli-args";
import { makeTable, nowIso, writeStdout } from "../../../../shared/cli-io";
import {
  initializeDataDir,
  loadVault,
  resolveDataDir,
  saveVault,
} from "../../../../infrastructure/persistence/local-store";
import {
  detectSourceType,
  extractProfileFromSources,
  extractTextFromFile,
} from "../../application/profile-extraction";

export async function cmdVault(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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
