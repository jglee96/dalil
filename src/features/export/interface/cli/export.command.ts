import { EXIT_USAGE } from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { assertNoExtraArgs, takeOption } from "../../../../shared/cli-args";
import { writeStdout } from "../../../../shared/cli-io";
import { SuggestLang } from "../../../../shared/types";
import {
  initializeDataDir,
  loadVault,
  resolveDataDir,
} from "../../../../infrastructure/persistence/local-store";
import {
  composeExportMarkdown,
  exportMarkdownFile,
} from "../../application/export-markdown.use-case";

export async function cmdExport(rawArgs: string[], dataDirOverride?: string): Promise<void> {
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
  const content = composeExportMarkdown(vault, artifact, lang, template);
  const outPath = exportMarkdownFile(outPathRaw, content);

  writeStdout(`Exported ${artifact} markdown to ${outPath}`);
}
