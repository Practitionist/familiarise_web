/**
 * What a server action returns instead of throwing a refusal. Anything a
 * "use server" function throws is captured by Next's `onRequestError` hook
 * (FAMILIARISE_WEB-13, -30), so an answer the caller can act on has to travel
 * as a value. Success and refusal are discriminated on `ok`.
 */

import type { Refusal, RefusalShape } from "./refusal";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; refusal: RefusalShape };

export function okResult<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function refusalResult(refusal: Refusal): ActionResult<never> {
  return { ok: false, refusal: refusal.toShape() };
}
