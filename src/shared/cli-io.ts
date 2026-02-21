import readline from "node:readline";
import { Writable } from "node:stream";

import { EXIT_ENV, EXIT_USAGE } from "./constants";
import { CliError } from "./errors/cli-error";

export function nowIso(): string {
  return new Date().toISOString();
}

export function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function makeTable(rows: string[][]): string {
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

export function redactValue(value: string): string {
  if (!value) {
    return "";
  }
  const email = value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
  return email.replace(/\b\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, "[redacted-phone]");
}

export function inferSite(url?: string): { hostname?: string; etldPlusOne?: string } {
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

export async function promptLine(question: string): Promise<string> {
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

export async function promptSecret(question: string): Promise<string> {
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

export async function confirm(question: string, defaultNo = true): Promise<boolean> {
  const raw = (await promptLine(`${question} ${defaultNo ? "(y/N)" : "(Y/n)"} `)).toLowerCase();
  if (!raw) {
    return !defaultNo;
  }
  return raw === "y" || raw === "yes";
}

export async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function ensureOpenAiConfirmation(preview: unknown): Promise<void> {
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
