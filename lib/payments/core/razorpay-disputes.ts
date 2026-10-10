/**
 * #1771 K-7 — Razorpay dispute evidence over raw HTTP, like the refund calls
 * in razorpay.ts: basic auth, a bounded timeout, typed errors.
 *
 *   GET   /v1/disputes/{id}            poll one dispute (reconcile-disputes)
 *   POST  /v1/documents              multipart `file` + `purpose=dispute_evidence`
 *   PATCH /v1/disputes/{id}/contest  action draft|submit, amount, summary, lists
 *
 * https://razorpay.com/docs/api/disputes/fetch/
 * https://razorpay.com/docs/api/documents/create/
 * https://razorpay.com/docs/api/disputes/contest/
 */

import type { DisputeStatus } from "@prisma/client";
import type { DisputeResult } from "./types";

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
    // The gateway's own error code/reason (e.g. BAD_REQUEST_ERROR /
    // input_validation_failed for an unknown id). Carried alongside — never
    // in place of — `code`, so existing callers keep their contract.
    readonly gatewayCode?: string,
    readonly reason?: string,
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
  const token = Buffer.from([keyId, keySecret].join(":")).toString("base64");
  return `Basic ${token}`;
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
    error?: { code?: string; description?: string; reason?: string };
  } | null;
  if (!res.ok) throw gatewayError(res.status, body?.error);
  return body as T;
}

/** A 4xx is Razorpay refusing (the operator's to act on); 401/403 is our
 *  keys and 5xx is Razorpay's — both 502 so the route pages them. */
function gatewayError(
  status: number,
  body?: { code?: string; description?: string; reason?: string },
) {
  const message = body?.description ?? `Razorpay answered HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new RazorpayDisputeError(message, "GATEWAY_AUTH_FAILED", 502);
  }
  if (status >= 500) {
    return new RazorpayDisputeError(message, "GATEWAY_ERROR", 502);
  }
  return new RazorpayDisputeError(
    message,
    "GATEWAY_REFUSED",
    409,
    body?.code,
    body?.reason,
  );
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

/** The GET /v1/disputes/:id entity (only the fields the poll reads). */
interface RazorpayDisputeEntity {
  id: string;
  payment_id?: string;
  status: string;
  respond_by?: number | null;
  evidence?: Record<string, unknown> | null;
  is_charge_refundable?: boolean;
  deduct_at_onset?: boolean;
}

/**
 * A polled Razorpay dispute: the shared DisputeResult shape plus the gateway
 * `payment_id` the reconciler joins on. `status` carries the RAW gateway
 * status (`open`/`under_review`/`won`/`lost`/`closed`) — the caller maps it
 * through the canonical mapDisputeStatus, the single mapping site.
 */
export type RazorpayDisputeResult = DisputeResult & {
  paymentId: string | null;
};

/**
 * True when Razorpay answered a dispute lookup with HTTP 400
 * `BAD_REQUEST_ERROR` / `input_validation_failed` — the shape it returns for
 * an id it has never seen (it never answers 404). Such an id cannot become
 * known on a later poll, so the reconciler flags it for manual review instead
 * of retrying it forever.
 */
export function isRazorpayUnknownDisputeIdError(
  error: unknown,
): error is RazorpayDisputeError {
  return (
    error instanceof RazorpayDisputeError &&
    error.gatewayCode === "BAD_REQUEST_ERROR" &&
    error.reason === "input_validation_failed"
  );
}

/** Fetches one dispute for the reconciler (GET-only: no contest/accept here). */
export async function getRazorpayDispute(
  disputeId: string,
): Promise<RazorpayDisputeResult> {
  const entity = await send<RazorpayDisputeEntity>(
    `${RAZORPAY_API_BASE}/disputes/${encodeURIComponent(disputeId)}`,
    {
      method: "GET",
      headers: { Authorization: authHeader() },
    },
  );
  const rawStatus = entity.status ?? "";
  return {
    disputeId: entity.id ?? disputeId,
    status: rawStatus as DisputeStatus,
    evidence: (entity.evidence ?? undefined) as
      Record<string, unknown> | undefined,
    // The fetch entity carries no refundability signal, so derive it the way
    // the seed does: a lost or refunded charge is no longer refundable.
    isChargeRefundable:
      entity.is_charge_refundable ??
      (typeof entity.deduct_at_onset === "boolean"
        ? entity.deduct_at_onset === false
        : !["lost", "charge_refunded"].includes(rawStatus.toLowerCase())),
    // respond_by is unix seconds, like the webhook entity.
    dueBy: entity.respond_by ? new Date(entity.respond_by * 1000) : undefined,
    paymentId: entity.payment_id ?? null,
  };
}
