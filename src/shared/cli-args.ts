import { EXIT_USAGE } from "./constants";
import { CliError } from "./errors/cli-error";

export function parseGlobalOptions(argv: string[]): { args: string[]; dataDirOverride?: string } {
  const args: string[] = [];
  let dataDirOverride: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--data-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError("`--data-dir` requires a path.", EXIT_USAGE);
      }
      dataDirOverride = value;
      i += 1;
      continue;
    }
    args.push(token);
  }
  return { args, dataDirOverride };
}

export function takeOption(args: string[], option: string): string | undefined {
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

export function takeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx < 0) {
    return false;
  }
  args.splice(idx, 1);
  return true;
}

export function assertNoExtraArgs(args: string[], context: string): void {
  if (args.length > 0) {
    throw new CliError(`Unexpected arguments for ${context}: ${args.join(" ")}`, EXIT_USAGE);
  }
}
