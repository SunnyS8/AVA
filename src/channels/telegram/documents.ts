import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

/** Max chars of extracted document text to avoid blowing the LLM context. */
const MAX_DOC_CHARS = 30000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yml", "yaml",
  "log", "ini", "cfg", "conf", "env", "toml",
  "js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp",
  "cs", "php", "sh", "bash", "sql", "html", "htm", "css", "scss", "less",
  "diff", "patch", "rtf", "sql",
]);

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : "";
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

function decodeText(buffer: Buffer): string {
  return buffer.toString("utf8");
}

/** Extract readable text from a document buffer based on file extension. */
export async function extractDocumentText(
  buffer: Buffer,
  fileName: string,
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const ext = extOf(fileName);
    let text: string;

    if (ext === "pdf") {
      text = await extractPdf(buffer);
    } else if (ext === "docx") {
      text = await extractDocx(buffer);
    } else if (ext === "doc") {
      return null; // legacy binary format — not supported
    } else if (TEXT_EXTENSIONS.has(ext)) {
      text = decodeText(buffer);
    } else if (buffer.length > 0 && buffer[0] !== 0x00 && !/\x00/.test(buffer.subarray(0, 512).toString("latin1"))) {
      // Fallback: try UTF-8 for unknown but text-looking content
      text = decodeText(buffer);
    } else {
      return null;
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\0/g, "").trim();
    if (!normalized) return null;

    const truncated = normalized.length > MAX_DOC_CHARS;
    return {
      text: truncated ? normalized.slice(0, MAX_DOC_CHARS) : normalized,
      truncated,
    };
  } catch {
    return null;
  }
}
