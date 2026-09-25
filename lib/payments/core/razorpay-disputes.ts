/**
 * #1771 K-7 — Razorpay dispute evidence over raw HTTP, like the refund calls
 * in razorpay.ts: basic auth, a bounded timeout, typed errors.
 *
 *   POST  /v1/documents              multipart `file` + `purpose=dispute_evidence`
 *   PATCH /v1/disputes/{id}/contest  action draft|submit, amount, summary, lists
 *
 * https://razorpay.com/docs/api/documents/create/
 * https://razorpay.com/docs/api/disputes/contest/
 */

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 15_000;

/** The document API's own limit; our route caps lower (Netlify buffers 6 MB). */
export const RAZORPAY_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
export const DISPUTE_EVIDENCE_MIME_TYPES = [
  "image/jpg",
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;
export const SUMMARY_MAX_CHARS = 1000;

/** The document-id lists the console offers, by Razorpay's own field names. */
export const EVIDENCE_LIST_KEYS = [
  "proof_of_service",
  "customer_communication",
  "refund_cancellation_policy",
  "term_and_conditions",
  "explanation_letter",
] as const;
export type EvidenceListKey = (typeof EVIDENCE_LIST_KEYS)[number];

export type ContestEvidence = Partial<Record<EvidenceListKey, string[]>> & {
  others?: { type: string; document_ids: string[] }[];
};

export type ContestAction = "draft" | "submit";

export class RazorpayDisputeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "RazorpayDisputeError";
  }
}

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
    throw new RazorpayDisputeError(
      "Razorpay credentials are not configured.",
      "RAZORPAY_NOT_CONFIGURED",
      503,
    );
  }
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

/** Every document id across the lists; `submit` needs at least one. */
export function evidenceDocumentCount(evidence: ContestEvidence): number {
  const lists = EVIDENCE_LIST_KEYS.map((k) => evidence[k] ?? []);
  const others = (evidence.others ?? []).map((o) => o.document_ids);
  return [...lists, ...others].reduce((n, ids) => n + ids.length, 0);
}

async function send<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new RazorpayDisputeError(
      `Razorpay did not answer: ${err instanceof Error ? err.message : String(err)}`,
      "GATEWAY_UNREACHABLE",
      502,
    );
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; description?: string };
  } | null;
  if (!res.ok) {
    // A 4xx is Razorpay refusing the request (state, deadline, shape); a 5xx is its fault.
    throw new RazorpayDisputeError(
      body?.error?.description ?? `Razorpay answered HTTP ${res.status}`,
      res.status >= 500 ? "GATEWAY_ERROR" : "GATEWAY_REFUSED",
      res.status >= 500 ? 502 : 409,
    );
  }
  return body as T;
}

/** Uploads one evidence file and answers its `doc_…` id. */
export async function uploadDisputeDocument(
  file: Blob,
  mime: string,
  fileName: string,
): Promise<{ id: string }> {
  if (!(DISPUTE_EVIDENCE_MIME_TYPES as readonly string[]).includes(mime)) {
    throw new RazorpayDisputeError(
      "Evidence must be a JPG, PNG or PDF file.",
      "EVIDENCE_TYPE_NOT_ALLOWED",
      400,
    );
  }
  if (file.size > RAZORPAY_DOCUMENT_MAX_BYTES) {
    throw new RazorpayDisputeError(
      "Evidence files must be 50 MB or smaller.",
      "EVIDENCE_TOO_LARGE",
      400,
    );
  }
  const form = new FormData();
  form.append("file", new Blob([file], { type: mime }), fileName);
  form.append("purpose", "dispute_evidence");
  const doc = await send<{ id: string }>(`${RAZORPAY_API_BASE}/documents`, {
    method: "POST",
    headers: { Authorization: authHeader() },
    body: form,
  });
  return { id: doc.id };
}

/**
 * Saves (`draft`) or submits (`submit`) the evidence. Razorpay only contests
 * an `open` dispute, and a submit moves it to `under_review`; a submit with no
 * document is refused here, before any call.
 */
export async function contestDispute(
  disputeId: string,
  input: {
    action: ContestAction;
    amountPaise?: number;
    summary: string;
    evidence: ContestEvidence;
  },
): Promise<{ id: string; status: string }> {
  if (input.summary.length > SUMMARY_MAX_CHARS) {
    throw new RazorpayDisputeError(
      `The summary must be ${SUMMARY_MAX_CHARS} characters or fewer.`,
      "SUMMARY_TOO_LONG",
      400,
    );
  }
  if (input.action === "submit" && evidenceDocumentCount(input.evidence) < 1) {
    throw new RazorpayDisputeError(
      "Attach at least one document before submitting.",
      "EVIDENCE_REQUIRED",
      400,
    );
  }
  const lists = Object.fromEntries(
    EVIDENCE_LIST_KEYS.filter((k) => (input.evidence[k] ?? []).length > 0).map(
      (k) => [k, input.evidence[k]],
    ),
  );
  return send<{ id: string; status: string }>(
    `${RAZORPAY_API_BASE}/disputes/${encodeURIComponent(disputeId)}/contest`,
    {
      method: "PATCH",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: input.action,
        summary: input.summary,
        ...(input.amountPaise ? { amount: input.amountPaise } : {}),
        ...lists,
        ...(input.evidence.others?.length
          ? { others: input.evidence.others }
          : {}),
      }),
    },
  );
}
