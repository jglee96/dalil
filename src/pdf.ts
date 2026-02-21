import { Buffer } from "node:buffer";

function pdfEscape(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildSimplePdf(text: string): Buffer {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(0, 55)
    .map((line) => line.trimEnd());

  const contentLines: string[] = [];
  contentLines.push("BT");
  contentLines.push("/F1 11 Tf");
  contentLines.push("50 790 Td");
  for (let i = 0; i < lines.length; i += 1) {
    const line = pdfEscape(lines[i]);
    if (i > 0) {
      contentLines.push("0 -14 Td");
    }
    contentLines.push(`(${line}) Tj`);
  }
  contentLines.push("ET");
  const stream = contentLines.join("\n");

  const objects: string[] = [];
  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj");
  objects.push("2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj");
  objects.push(
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
  );
  objects.push("4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj");
  objects.push(
    `5 0 obj << /Length ${Buffer.byteLength(stream, "utf8")} >> stream\n${stream}\nendstream endobj`,
  );

  let body = "";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${obj}\n`;
  }

  const header = "%PDF-1.4\n";
  const xrefStart = Buffer.byteLength(header + body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    const offset = Buffer.byteLength(header, "utf8") + offsets[i];
    xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, "utf8");
}
