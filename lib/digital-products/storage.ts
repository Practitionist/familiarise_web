/** The private R2 bucket product files live in; same credentials as the recordings bucket. */
export function digitalProductsBucket(): string {
  const bucket = process.env.R2_DIGITAL_PRODUCTS_BUCKET?.trim();
  if (!bucket) {
    throw new Error("R2_DIGITAL_PRODUCTS_BUCKET is not configured");
  }
  return bucket;
}

/** Attachment disposition with an ASCII fallback and the RFC 8187 UTF-8 name. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * bare, which RFC 8187 attr-char excludes.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
