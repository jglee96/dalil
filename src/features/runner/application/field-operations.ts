import { createHash } from "node:crypto";

import { FormField } from "../../../shared/types";

function makeFieldId(domPath: string, label: string, type: string): string {
  const digest = createHash("sha1")
    .update(`${domPath}::${label}::${type}`)
    .digest("hex")
    .slice(0, 12);
  return `fld_${digest}`;
}

export async function scanFieldsOnPage(page: any): Promise<FormField[]> {
  const raw = (await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("input:not([type=hidden]):not([type=password]):not([type=file]), textarea"),
    ) as Array<HTMLInputElement | HTMLTextAreaElement>;

    const uniq = (arr: string[]): string[] => Array.from(new Set(arr.map((v) => v.trim()).filter(Boolean)));

    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        let part = node.tagName.toLowerCase();
        if ((node as HTMLElement).id) {
          part += `#${CSS.escape((node as HTMLElement).id)}`;
          parts.unshift(part);
          break;
        }
        const parent = node.parentElement;
        if (parent) {
          const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node?.tagName);
          if (sameTagSiblings.length > 1) {
            const idx = sameTagSiblings.indexOf(node) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };

    const readLabel = (el: HTMLInputElement | HTMLTextAreaElement): string => {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "";
      if (byFor && byFor.trim()) {
        return byFor.trim();
      }
      const wrapping = el.closest("label")?.textContent;
      if (wrapping && wrapping.trim()) {
        return wrapping.trim();
      }
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) {
        return aria.trim();
      }
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const nodes = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean);
        if (nodes.length > 0) {
          return nodes.join(" ");
        }
      }
      return el.getAttribute("name") || el.getAttribute("placeholder") || "(unlabeled field)";
    };

    const nearbyHints = (el: HTMLInputElement | HTMLTextAreaElement): string[] => {
      const hints: string[] = [];
      const parent = el.parentElement;
      if (!parent) {
        return hints;
      }
      const selectors = [".help", ".hint", ".description", ".helper", "[data-help]", "[data-hint]"];
      for (const selector of selectors) {
        parent.querySelectorAll(selector).forEach((node) => hints.push(node.textContent?.trim() || ""));
      }
      const siblingText = Array.from(parent.children)
        .filter((n) => n !== el)
        .map((n) => n.textContent?.trim() || "")
        .filter((txt) => /character|자|글자|word|영문|한글/i.test(txt));
      hints.push(...siblingText);
      return uniq(hints).slice(0, 4);
    };

    return nodes.map((el) => ({
      domPath: cssPath(el),
      type: el.tagName.toLowerCase() === "textarea" ? "textarea" : `input:${(el as HTMLInputElement).type || "text"}`,
      name: el.getAttribute("name") || undefined,
      label: readLabel(el),
      placeholder: el.getAttribute("placeholder") || undefined,
      hints: nearbyHints(el),
      required: el.required,
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : undefined,
      pattern: el.getAttribute("pattern") || undefined,
    }));
  })) as Array<{
    domPath: string;
    type: string;
    name?: string;
    label: string;
    placeholder?: string;
    hints: string[];
    required: boolean;
    maxLength?: number;
    pattern?: string;
  }>;

  const fields = raw.map((f) => {
    const languageHint = f.hints.find((hint) => /영문|english|한글|korean/i.test(hint));
    return {
      fieldId: makeFieldId(f.domPath, f.label, f.type),
      domPath: f.domPath,
      type: f.type,
      name: f.name,
      label: f.label,
      placeholder: f.placeholder,
      hints: f.hints,
      constraints: {
        required: f.required,
        maxLength: f.maxLength,
        pattern: f.pattern,
        languageHint,
      },
    } as FormField;
  });

  return fields;
}

export async function ensureFieldExists(page: any, domPath: string): Promise<boolean> {
  const exists = (await page.evaluate((selector: string) => {
    return Boolean(document.querySelector(selector));
  }, domPath)) as boolean;
  return exists;
}

export async function highlightField(page: any, domPath: string): Promise<void> {
  await page.evaluate((selector: string) => {
    const node = document.querySelector(selector) as HTMLElement | null;
    if (!node) {
      throw new Error("Field not found");
    }
    const original = node.style.outline;
    node.style.outline = "3px solid #ff6b00";
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      node.style.outline = original;
    }, 2000);
  }, domPath);
}

export async function readFieldValue(page: any, domPath: string): Promise<string> {
  const value = (await page.evaluate((selector: string) => {
    const node = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!node) {
      throw new Error("Field not found");
    }
    return node.value || "";
  }, domPath)) as string;
  return value;
}

export async function setFieldValue(page: any, domPath: string, text: string): Promise<void> {
  await page.evaluate(
    ({ selector, payload }: { selector: string; payload: string }) => {
      const node = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!node) {
        throw new Error("Field not found");
      }
      node.value = payload;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { selector: domPath, payload: text },
  );
}

export async function typeIntoField(page: any, domPath: string, text: string): Promise<void> {
  const locator = page.locator(domPath).first();
  await locator.click();
  await locator.fill("");
  await locator.type(text, { delay: 4 });
}

export async function getPageInfo(page: any): Promise<{ url?: string; title?: string }> {
  const info = (await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
  }))) as { url?: string; title?: string };
  return info;
}
