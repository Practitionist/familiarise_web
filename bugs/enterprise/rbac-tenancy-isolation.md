# RBAC & Tenant Isolation

## Context

Org RBAC: `MemberRole` ladder + surface permissions (`members.manage`, `billing.manage`, …). Enforcement: `requireOrgAccess` requires ACTIVE membership (ADMIN stub exception), optional capability/funding gates. BetterAuth `Member` kept for invite tokens; `Membership` is source of truth. LEARNER ↔ EXPERT transitions blocked — remove and re-invite.

## Known gaps / bugs

- No Postgres RLS — service-role Prisma; defense-in-depth deferred.
- Hierarchy `parentOrganizationId` / subtree scoping not in `requireOrgAccess` (#771) — APIs stub 501.
- `exclusiveEngagement` unenforced — experts may still sell B2C independently.
- Settings: some UI fields MAINTAINER-visible but OWNER-only in API (#779 class of bugs).
- Bulk member API returns deterministic 405 (anti-lockout) — HRIS expectation mismatch.
- Invite EXPERT requires existing ConsultantProfile; SSO JIT can lazy-create — asymmetry.

## Unhappy paths & user psychology

- Disgruntled MANAGER keeps billing bookmark; role demoted but cached UI still offers actions until 403.
- Two orgs claim same domain — SSO exclusivity is global unique; loser blocked without clear dispute UX.
- Last OWNER tries to leave — need anti-lockout; bulk ops disabled may frustrate IT.

## Questions (handled?)

1. **RLS timeline vs design-partner contracts?**  
   - A) Document API isolation as sufficient  
   - B) RLS before any SOC 2 language  
   - C) RLS only when Supabase client exposure  

2. **EXPERT invite — lazy-create consultant profile?**  
   - A) Parity with SSO JIT  
   - B) Keep strict “onboard as consultant first”  
   - C) Org-hosted expert profile distinct from marketplace consultant  

3. **Domain claim disputes process?**  
   - A) Manual admin arbitration  
   - B) DNS re-verify winner takes all  
   - C) Allow shared domains with break-glass  

## High concurrency / multi-device

Invite accept atomic; pending invite unique; seat counters conditional. Session veto for SSO-enforced domains. Stale sessions up to clock skew if `sessionGeneration` missed.

## Suggested directions

Align invite vs SSO expert creation rules. Fix UI/API permission drift on settings.
