import { deflateRawSync } from "node:zlib";

/**
 * Report file writers (REP-003, REP-004, REP-005). No third-party library:
 * - CSV: RFC 4180 quoting, UTF-8 with BOM, CRLF, spreadsheet formula injection neutralised;
 * - XLSX: a genuine Office Open XML workbook (zip container, typed cells, number/date formats);
 * - PDF: a genuine PDF 1.4 document (Helvetica, landscape A4, repeated table header, page numbers).
 * Timestamps are shown in the institute time zone (IST, UTC+05:30).
 */

export type ColumnType = "text" | "int" | "money" | "date" | "datetime";

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ReportDocument {
  title: string;
  generatedAt: Date;
  /** Human-readable filter lines, e.g. "Date range: 2026-04-01 to 2026-04-30". */
  filters: string[];
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

const IST_OFFSET_MS = 330 * 60 * 1000;

const asDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** "YYYY-MM-DD" (date columns are calendar dates and are not shifted). */
const dateText = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** "YYYY-MM-DD HH:mm" in IST. */
const dateTimeText = (d: Date): string => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${dateText(ist)} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
};

const numberOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Display text used by CSV and PDF. */
export function formatCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "int": {
      const n = numberOf(value);
      return n === null ? String(value) : String(Math.trunc(n));
    }
    case "money": {
      const n = numberOf(value);
      return n === null ? String(value) : n.toFixed(2);
    }
    case "date": {
      const d = asDate(value);
      return d ? dateText(d) : String(value);
    }
    case "datetime": {
      const d = asDate(value);
      return d ? dateTimeText(d) : String(value);
    }
    default:
      return String(value);
  }
}

// ------------------------------------------------------------------ CSV
const FORMULA_START = /^[=+\-@\t\r]/;

const csvField = (text: string, isText: boolean): string => {
  // A text cell starting with = + - @ would be executed as a formula by spreadsheet apps.
  const safe = isText && FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(doc: Pick<ReportDocument, "columns" | "rows">): Buffer {
  const lines = [doc.columns.map((c) => csvField(c.label, true)).join(",")];
  for (const row of doc.rows) {
    lines.push(doc.columns.map((c) => csvField(formatCell(row[c.key], c.type), c.type === "text")).join(","));
  }
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

// ------------------------------------------------------------------ ZIP (for XLSX)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const compressed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + compressed.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// ------------------------------------------------------------------ XLSX
const xmlEscape = (s: string): string =>
  s
    // Characters XML 1.0 cannot carry.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const colName = (i: number): string => {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Excel serial day number (1900 date system). */
const excelSerial = (ms: number): number => ms / 86_400_000 + 25569;

// Style indexes in styles.xml: 0 default, 1 header, 2 date, 3 date-time, 4 money, 5 integer.
const STYLE: Record<ColumnType, number> = { text: 0, date: 2, datetime: 3, money: 4, int: 5 };

export function toXlsx(doc: ReportDocument): Buffer {
  const sheetName = xmlEscape(doc.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report");
  const rowsXml: string[] = [];
  let r = 1;
  const textRow = (text: string, style = 0) =>
    `<row r="${r}"><c r="A${r}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c></row>`;

  rowsXml.push(textRow(doc.title, 1));
  r++;
  rowsXml.push(textRow(`Generated: ${dateTimeText(doc.generatedAt)} IST`));
  r++;
  for (const f of doc.filters) {
    rowsXml.push(textRow(f));
    r++;
  }
  r++; // blank line
  const headerRow = r;
  rowsXml.push(
    `<row r="${r}">${doc.columns
      .map((c, i) => `<c r="${colName(i)}${r}" t="inlineStr" s="1"><is><t>${xmlEscape(c.label)}</t></is></c>`)
      .join("")}</row>`,
  );
  r++;
  for (const row of doc.rows) {
    const cells = doc.columns.map((c, i) => {
      const ref = `${colName(i)}${r}`;
      const v = row[c.key];
      if (v === null || v === undefined || v === "") return `<c r="${ref}"/>`;
      if (c.type === "int" || c.type === "money") {
        const n = numberOf(v);
        if (n !== null) return `<c r="${ref}" s="${STYLE[c.type]}"><v>${n}</v></c>`;
      }
      if (c.type === "date" || c.type === "datetime") {
        const d = asDate(v);
        if (d) {
          const serial = c.type === "date" ? excelSerial(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : excelSerial(d.getTime() + IST_OFFSET_MS);
          return `<c r="${ref}" s="${STYLE[c.type]}"><v>${serial}</v></c>`;
        }
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(v))}</t></is></c>`;
    });
    rowsXml.push(`<row r="${r}">${cells.join("")}</row>`);
    r++;
  }
  const lastCol = colName(Math.max(doc.columns.length - 1, 0));
  const widths = doc.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.type === "datetime" ? 18 : c.type === "text" ? 24 : 14}" customWidth="1"/>`)
    .join("");

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${rowsXml.join("")}</sheetData>${
    doc.columns.length ? `<autoFilter ref="A${headerRow}:${lastCol}${Math.max(r - 1, headerRow)}"/>` : ""
  }</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

  return zip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    { name: "xl/styles.xml", data: Buffer.from(styles) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]);
}

// ------------------------------------------------------------------ PDF
const PAGE_W = 842; // A4 landscape, points
const PAGE_H = 595;
const MARGIN = 36;
const FONT_SIZE = 8;
const ROW_H = 13;

/** Helvetica is a WinAnsi font: characters outside Latin-1 are replaced, the rupee sign is spelled out. */
const pdfText = (s: string): string =>
  s
    .replace(/₹/g, "INR ")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

/** Approximate Helvetica advance width (points) for fitting text into a column. */
const textWidth = (s: string, size: number): number => s.length * size * 0.52;

const fit = (s: string, width: number, size: number): string => {
  if (textWidth(s, size) <= width) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}...`, size) > width) out = out.slice(0, -1);
  return `${out}...`;
};

export function toPdf(doc: ReportDocument): Buffer {
  const usable = PAGE_W - 2 * MARGIN;
  const weights = doc.columns.map((c) => (c.type === "text" ? 2 : c.type === "datetime" ? 1.5 : 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => (usable * w) / totalWeight);
  const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const rightAligned = (t: ColumnType) => t === "int" || t === "money";

  const cell = (text: string, col: number, y: number, bold = false): string => {
    const c = doc.columns[col]!;
    const s = fit(text, widths[col]! - 4, FONT_SIZE);
    const x = rightAligned(c.type) ? xs[col]! + widths[col]! - 2 - textWidth(s, FONT_SIZE) : xs[col]! + 2;
    return `BT /${bold ? "F2" : "F1"} ${FONT_SIZE} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${pdfText(s)}) Tj ET`;
  };

  // Lay out pages.
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 0;
  const startPage = (first: boolean) => {
    ops = [];
    pages.push(ops);
    y = PAGE_H - MARGIN;
    if (first) {
      ops.push(`BT /F2 14 Tf ${MARGIN} ${y - 14} Td (${pdfText(doc.title)}) Tj ET`);
      y -= 30;
      ops.push(`BT /F1 9 Tf ${MARGIN} ${y} Td (${pdfText(`Generated: ${dateTimeText(doc.generatedAt)} IST`)}) Tj ET`);
      y -= 12;
      for (const f of doc.filters) {
        ops.push(`BT /F1 9 Tf ${MARGIN} ${y} Td (${pdfText(fit(f, usable, 9))}) Tj ET`);
        y -= 12;
      }
      y -= 6;
    } else {
      ops.push(`BT /F2 9 Tf ${MARGIN} ${y - 9} Td (${pdfText(`${doc.title} (continued)`)}) Tj ET`);
      y -= 20;
    }
    // Table header, repeated on every page.
    ops.push(`0.9 0.9 0.95 rg ${MARGIN} ${(y - ROW_H + 9).toFixed(1)} ${usable} ${ROW_H} re f 0 0 0 rg`);
    doc.columns.forEach((c, i) => ops.push(cell(c.label, i, y, true)));
    y -= ROW_H;
  };

  startPage(true);
  if (doc.rows.length === 0) {
    ops.push(`BT /F1 9 Tf ${MARGIN} ${y} Td (${pdfText("No records match the selected filters.")}) Tj ET`);
  }
  for (const row of doc.rows) {
    if (y < MARGIN + ROW_H) startPage(false);
    doc.columns.forEach((c, i) => ops.push(cell(formatCell(row[c.key], c.type), i, y)));
    ops.push(`0.85 0.85 0.85 RG 0.3 w ${MARGIN} ${(y - 3.5).toFixed(1)} m ${PAGE_W - MARGIN} ${(y - 3.5).toFixed(1)} l S`);
    y -= ROW_H;
  }
  pages.forEach((p, i) => p.push(`BT /F1 8 Tf ${PAGE_W - MARGIN - 60} ${MARGIN / 2} Td (Page ${i + 1} of ${pages.length}) Tj ET`));

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then (page, content) pairs.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  pages.forEach((p, i) => {
    const content = p.join("\n");
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info << /Title (${pdfText(doc.title)}) /Producer (Nexelvoria Academy) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const EXPORT_TYPES = {
  csv: { contentType: "text/csv; charset=utf-8", extension: "csv" },
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" },
  pdf: { contentType: "application/pdf", extension: "pdf" },
} as const;
export type ExportFormat = keyof typeof EXPORT_TYPES;

export function renderReport(format: ExportFormat, doc: ReportDocument): Buffer {
  if (format === "csv") return toCsv(doc);
  if (format === "xlsx") return toXlsx(doc);
  return toPdf(doc);
}
