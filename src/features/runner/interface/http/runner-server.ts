import http, { IncomingMessage, ServerResponse } from "node:http";

import {
  EXIT_ENV,
  EXIT_USAGE,
  RUNNER_DEFAULT_PORT,
  SCHEMA_VERSION,
} from "../../../../shared/constants";
import { CliError } from "../../../../shared/errors/cli-error";
import { nowIso } from "../../../../shared/cli-io";
import { FormField, Mode } from "../../../../shared/types";
import {
  ensureDir,
  loadRunnerConnection,
  pathInDataDir,
  saveRuntimeState,
} from "../../../../infrastructure/persistence/local-store";
import {
  ensureFieldExists,
  getPageInfo,
  highlightField,
  readFieldValue,
  scanFieldsOnPage,
  setFieldValue,
  typeIntoField,
} from "../../application/field-operations";

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

export async function startRunnerServer(params: {
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

export async function runnerRequest<T>(dataDir: string, endpoint: string, init?: RequestInit): Promise<T> {
  const conn = loadRunnerConnection(dataDir);
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
