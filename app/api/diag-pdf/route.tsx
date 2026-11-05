/** @jsxImportSource @/lib/pdf/react-runtime */
// TEMPORARY diagnostic for #2522 on the experiment branch only; never merged.
import { NextResponse } from "next/server";
import { createRequire } from "node:module";
import { join } from "node:path";

export const dynamic = "force-dynamic";

function probe(label: string, fn: () => string) {
  try {
    return { label, ok: true, value: fn() };
  } catch (error) {
    return { label, ok: false, value: String(error).slice(0, 200) };
  }
}

export async function GET() {
  const cwdRequire = createRequire(join(process.cwd(), "package.json"));
  const report = {
    cwd: process.cwd(),
    hasNonWebpackRequire: typeof (globalThis as Record<string, unknown>)
      .__non_webpack_require__,
    probes: [
      probe("cwd react", () => cwdRequire.resolve("react")),
      probe("cwd react-pdf", () => cwdRequire.resolve("@react-pdf/renderer")),
      probe("cwd react version", () =>
        String((cwdRequire("react") as { version: string }).version),
      ),
    ],
    render: { ok: false, bytes: 0, error: "" },
  };
  try {
    const { Document, Page, Text, renderToBuffer } =
      await import("@react-pdf/renderer");
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <Text>turbopack react-pdf probe</Text>
        </Page>
      </Document>,
    );
    report.render = {
      ok: buffer.subarray(0, 4).toString() === "%PDF",
      bytes: buffer.length,
      error: "",
    };
  } catch (error) {
    report.render = { ok: false, bytes: 0, error: String(error).slice(0, 400) };
  }
  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store" },
  });
}
