# Referral Capture Across Signup and Onboarding

A referral code must survive three gaps between the first click and an authenticated account: a full-page OAuth redirect, the wait for email verification, and a switch of tab. This document describes how the code is captured at first touch and applied once the user is signed in.

## 1. Capture at first touch

The code is kept in two places so that either one can recover it.

| Store                                                  | Written by                                                   | Survives                                                |
| ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------- |
| `fam_ref` cookie, 30 days, readable by script          | `app/r/[code]/route.ts` for every valid code                 | An OAuth round trip, and a new tab on the same browser. |
| `familiarise.pendingReferral` in browser local storage | `setPendingReferral`, called by the signup page from `?ref=` | A reload and email verification on the same browser.    |

`lib/pending-referral.ts` reads local storage first and falls back to the cookie. The code is trimmed and checked with a small Zod schema before it is stored, and a landing on signup without `?ref=` never erases a stored code. Storage is best effort. A private window, or opening the link on another device, loses the code, which the product accepts.

## 2. Apply after authentication

A signed-in visitor to `/r/<code>` has the code applied by the route itself, subject to the apply rate limit, and lands on `/dashboard`. Everyone else is sent to `/auth/signup?ref=<code>`.

For a new account, the single apply point is the onboarding page. When a session exists, it reads the stored code and calls `POST /api/referrals/apply`. The call is idempotent because `Referral.referredUserId` is unique. The stored code is cleared on success or on a 400, which means the code is invalid, already used by this account, or refused by a rule. A network failure, a 429 or a 5xx leaves the code in place so a later authenticated render can retry.

Applying a code only creates the `Referral` row in `SIGNED_UP`. No credit and no discount exists yet. The apply step refuses an account that was created before the qualify window began, an account with an earlier paid booking, and any request while the programme takes no new referees, so an existing customer cannot be turned into a referee afterwards.

## 3. The expert link has no onboarding step

An expert's signed link needs no account at the moment of the click. The `fam_via` cookie is set by the middleware on the expert's public page, and the token is verified at checkout, which may happen weeks later. The buyer's signup path is independent of it.

## 4. Path matrix

The table shows where the referral code is applied for each way of signing up.

| Sign-up path          | Email verification                 | Session at signup        | Where the code is applied                             |
| --------------------- | ---------------------------------- | ------------------------ | ----------------------------------------------------- |
| Email and password    | Required, by link or one-time code | No, only after verifying | Onboarding, after verification and automatic sign-in. |
| Google or other OAuth | Trusted from the provider          | Yes, after the redirect  | Onboarding, on the first authenticated landing.       |
| Enterprise SSO        | Trusted from the identity provider | Yes, after the redirect  | Onboarding, on the first authenticated landing.       |
| Already signed in     | Not applicable                     | Yes                      | The `/r/<code>` route, at once.                       |

## 5. Why capture does not weaken the anti-farming rules

Capture and apply record attribution only. The reward is released later by the vest sweep, after a delivered, held and unrefunded paid session, and it is bounded by the budget and caps described in [04-reward-economics-and-decisions.md](./04-reward-economics-and-decisions.md). Widening capture to OAuth and verified-email signups therefore adds coverage without adding a way to farm rewards.

## 6. Signup verification policy

A verified email is the universal gate for a new account. The platform trusts the verified-email claim from OAuth providers and enterprise SSO. Phone verification is not a signup requirement. It is a planned risk-based step at money-moving moments, and it is not built.

## Deprecated & Superseded Approaches

An earlier plan applied the code right after signup with a client call that needed a session. That failed for OAuth signups, which lose `?ref=` in the redirect, and for email signups, which have no session until verified. The apply step moved to onboarding, and capture moved to first touch. The first version also granted a referee credit at signup, which the pre-tax welcome discount replaced.

Residual artifacts to delete when found:

- Any call to `POST /api/referrals/apply` from the signup submit handler.
- Any copy that promises the referee a credit at signup. The referee gets a discount on the first booking.
- The status banner "Planned" and the branch name `feat/email-verification-referral-capture` from the earlier document.
