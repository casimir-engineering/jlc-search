/**
 * PDF text extraction using pdftotext (poppler-utils).
 * System dependency: apt-get install poppler-utils
 */

/** Extract text from a PDF file. Returns null if extraction fails or yields no text. */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["pdftotext", "-layout", pdfPath, "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return text.trim() || null;
  } catch {
    return null;
  }
}

/** Get page count from a PDF file using pdfinfo. */
export async function getPdfPageCount(pdfPath: string): Promise<number> {
  try {
    const proc = Bun.spawn(["pdfinfo", pdfPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const info = await new Response(proc.stdout).text();
    await proc.exited;
    const match = info.match(/Pages:\s+(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch {
    return 0;
  }
}
