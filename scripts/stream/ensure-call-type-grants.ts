/**
 * Enforces least-privilege role grants on `STREAM_CALL_TYPE` (`default`),
 * revoking unguarded join (`join-call`, `join-ended-call`, `update-call-permissions`)
 * from `user`/`guest` and `end-call` plus all 18 billable permissions (including
 * `-owner` and `-any-team` variants) from `user`, `guest`, and `call_member`.
 *
 *   npx tsx scripts/stream/ensure-call-type-grants.ts
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --routes-are-deployed
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getStreamVideoClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { CALL_MEMBER_ROLE, STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import { canonical } from "../../lib/stream/config-fingerprint";
import { anyOpenCallMemberHolds } from "./backfill-call-member-role";
import {
  BILLABLE_PERMISSIONS,
  matchesPermissionWithScope,
} from "./harden-unused-call-types";

const CREATE_CALL = "create-call";
const JOIN_CALL = "join-call";
const JOIN_REVOKED_ROLES = ["user", "guest"];
const END_CALL = "end-call";
const NON_MEMBER_REVOKED_PERMISSIONS = [
  JOIN_CALL,
  "join-ended-call",
  "update-call-permissions",
];
export const DEFAULT_CALL_TYPE_REVOKED_PERMISSIONS = [
  ...BILLABLE_PERMISSIONS,
  CREATE_CALL,
  END_CALL,
];
const RECORDING_REVOKED_ROLES = [...JOIN_REVOKED_ROLES, CALL_MEMBER_ROLE];

export function isRevokedClientPermission(perm: string): boolean {
  return matchesPermissionWithScope(
    perm,
    DEFAULT_CALL_TYPE_REVOKED_PERMISSIONS,
  );
}

function isRevokedNonMemberPermission(perm: string): boolean {
  return (
    matchesPermissionWithScope(perm, NON_MEMBER_REVOKED_PERMISSIONS) ||
    isRevokedClientPermission(perm)
  );
}

export interface EnsureCallTypeGrantsOptions {
  apply: boolean;
  restore: boolean;
  deployConfirmed: boolean;
}

function parseArgs(argv: string[]): EnsureCallTypeGrantsOptions {
  return {
    apply: argv.includes("--apply"),
    restore: argv.includes("--restore-user-join"),
    deployConfirmed:
      argv.includes("--routes-are-deployed") ||
      argv.includes("--join-route-is-deployed") ||
      argv.includes("--confirm-join-route-deployed"),
  };
}

function requireDeployConfirmation(opts: EnsureCallTypeGrantsOptions): boolean {
  if (!opts.apply || opts.restore || opts.deployConfirmed) return true;

  console.error(
    "\n🛑 Refusing to apply.\n" +
      "\nThis write depends on POST /api/meetings/[meetingId]/join and POST /api/meetings/[meetingId]/end serving production traffic.\n" +
      "\nDeploy first. Confirm the route is live. Then re-run with:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --routes-are-deployed\n" +
      "\nIf you get it wrong, the rollback is:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join\n",
  );
  return false;
}

function formatAffectedCallsSuffix(calls: string[]): string {
  if (calls.length === 0) return "";
  const listed = calls.slice(0, 10).join(", ");
  const overflow = calls.length > 10 ? ` … and ${calls.length - 10} more` : "";
  return `\n\nAffected calls: ${listed}${overflow}`;
}

async function requireSomeoneHoldsMemberRole(
  client: ReturnType<typeof getStreamVideoClient>,
  opts: EnsureCallTypeGrantsOptions,
): Promise<boolean> {
  if (!opts.apply || opts.restore) return true;

  let scan: Awaited<ReturnType<typeof anyOpenCallMemberHolds>>;
  try {
    scan = await anyOpenCallMemberHolds(client, CALL_MEMBER_ROLE);
  } catch (err) {
    console.error(
      `\n🛑 Refusing to apply — could not read call members from Stream.\n`,
      err,
    );
    return false;
  }

  if (scan.callsScanned === 0) {
    console.log(
      `ℹ️  No open calls to check — nobody can be locked out of a call that does not exist.`,
    );
    return true;
  }

  if (scan.found) return true;

  console.error(
    `\n🛑 Refusing to apply.\n` +
      `\nScanned ${scan.callsScanned} open call(s). ${scan.membersMissingRole} member(s)` +
      `\nacross ${scan.callsWithUncoveredMembers.length} call(s) do NOT hold \`${CALL_MEMBER_ROLE}\`.` +
      formatAffectedCallsSuffix(scan.callsWithUncoveredMembers) +
      `\n\nBackfill the role first, then re-run:` +
      `\n  npx tsx scripts/stream/backfill-call-member-role.ts --apply\n`,
  );
  return false;
}

function computeRestoredGrants(
  existingGrants: Record<string, string[]>,
): Record<string, string[]> {
  const grants: Record<string, string[]> = { ...existingGrants };
  for (const role of JOIN_REVOKED_ROLES) {
    const roleGrants = grants[role];
    if (roleGrants && !roleGrants.includes(JOIN_CALL)) {
      grants[role] = [...roleGrants, JOIN_CALL];
    }
  }
  const restoreMember = grants[CALL_MEMBER_ROLE];
  if (restoreMember && !restoreMember.includes(END_CALL)) {
    grants[CALL_MEMBER_ROLE] = [...restoreMember, END_CALL];
  }
  return grants;
}

function computeUpdatedGrants(
  existingGrants: Record<string, string[]>,
  restore: boolean,
): Record<string, string[]> {
  if (restore) {
    return computeRestoredGrants(existingGrants);
  }

  const grants: Record<string, string[]> = { ...existingGrants };

  for (const role of JOIN_REVOKED_ROLES) {
    const roleGrants = grants[role];
    if (roleGrants) {
      grants[role] = roleGrants.filter((g) => !isRevokedNonMemberPermission(g));
    }
  }

  for (const role of RECORDING_REVOKED_ROLES) {
    const roleGrants = grants[role];
    if (roleGrants) {
      grants[role] = roleGrants.filter((g) => !isRevokedClientPermission(g));
    }
  }

  const memberGrants = grants[CALL_MEMBER_ROLE] ?? [];
  if (!memberGrants.includes(JOIN_CALL)) {
    grants[CALL_MEMBER_ROLE] = [...memberGrants, JOIN_CALL];
  }

  return grants;
}

function logGrantChanges(
  existingGrants: Record<string, string[]>,
  grants: Record<string, string[]>,
): void {
  console.log(`Call type: ${STREAM_CALL_TYPE}`);
  for (const role of [...JOIN_REVOKED_ROLES, CALL_MEMBER_ROLE, "admin"]) {
    const had = (existingGrants[role] ?? []).includes(JOIN_CALL);
    const now = (grants[role] ?? []).includes(JOIN_CALL);
    const suffix = grants[role] ? "" : "   (role absent on this call type)";
    console.log(`  ${role.padEnd(12)} join-call: ${had} → ${now}${suffix}`);
  }
  for (const role of RECORDING_REVOKED_ROLES) {
    const allPerms = new Set([
      ...(existingGrants[role] ?? []),
      ...(grants[role] ?? []),
    ]);
    for (const perm of allPerms) {
      if (perm === JOIN_CALL) continue;
      const had = (existingGrants[role] ?? []).includes(perm);
      const now = (grants[role] ?? []).includes(perm);
      if (had === now) continue;
      console.log(`  ${role.padEnd(12)} ${perm.padEnd(28)}: ${had} → ${now}`);
    }
  }
}

function verifyGrantsAfterWrite(
  verifyGrants: Record<string, string[]>,
  desiredGrants: Record<string, string[]>,
  restore: boolean,
): boolean {
  const memberPostWrite = verifyGrants[CALL_MEMBER_ROLE] ?? [];
  if (!restore && !memberPostWrite.includes(JOIN_CALL)) {
    console.error(
      `\n🚨 ${CALL_MEMBER_ROLE} does NOT hold ${JOIN_CALL} on Stream after this write.`,
    );
    return false;
  }

  if (!restore && memberPostWrite.some((g) => isRevokedClientPermission(g))) {
    console.error(
      `\n🚨 ${CALL_MEMBER_ROLE} still holds a revoked control or billable permission on Stream after this write.`,
    );
    return false;
  }

  if (
    restore &&
    (desiredGrants[CALL_MEMBER_ROLE] ?? []).includes(END_CALL) &&
    !memberPostWrite.includes(END_CALL)
  ) {
    console.error(
      `\n🚨 ${CALL_MEMBER_ROLE} still lacks ${END_CALL} on Stream after the rollback.`,
    );
    return false;
  }

  return true;
}

function verifySettingsUnchanged(
  existing: { settings: unknown; notification_settings: unknown },
  verify: { settings: unknown; notification_settings: unknown },
): boolean {
  const settingsUnchanged =
    canonical(verify.settings) === canonical(existing.settings);
  const notificationsUnchanged =
    canonical(verify.notification_settings) ===
    canonical(existing.notification_settings);
  if (settingsUnchanged && notificationsUnchanged) return true;

  const preImagePath = join(
    tmpdir(),
    `stream-call-type-${STREAM_CALL_TYPE}-preimage.json`,
  );
  const preImage = JSON.stringify(
    {
      callType: STREAM_CALL_TYPE,
      settings: existing.settings,
      notification_settings: existing.notification_settings,
    },
    null,
    2,
  );
  try {
    writeFileSync(preImagePath, preImage);
  } catch (err) {
    console.error(
      `(could not write the pre-image to ${preImagePath}:`,
      err,
      ")",
    );
    console.error(preImage);
  }

  console.error(
    `\n⚠️  updateCallType CHANGED configuration it was not given.` +
      `\n   Restore from: ${preImagePath}\n`,
  );
  return false;
}

export async function ensureCallTypeGrants(
  opts: EnsureCallTypeGrantsOptions,
): Promise<number> {
  if (!requireDeployConfirmation(opts)) return 1;

  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamVideoClient();

  if (!(await requireSomeoneHoldsMemberRole(client, opts))) return 1;
  const existing = await client.video.getCallType({ name: STREAM_CALL_TYPE });

  const before = JSON.stringify(existing.grants, null, 2);
  const grants = computeUpdatedGrants(existing.grants, opts.restore);
  const after = JSON.stringify(grants, null, 2);

  if (before === after) {
    console.log(
      `✅ call type "${STREAM_CALL_TYPE}" already has the desired grants — no change`,
    );
    return 0;
  }

  logGrantChanges(existing.grants, grants);

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  await client.video.updateCallType({ name: STREAM_CALL_TYPE, grants });
  const verify = await client.video.getCallType({ name: STREAM_CALL_TYPE });

  if (!verifyGrantsAfterWrite(verify.grants, grants, opts.restore)) return 1;
  if (!verifySettingsUnchanged(existing, verify)) return 1;

  console.log(
    `\n✅ applied — settings and notification_settings verified unchanged.`,
  );
  return 0;
}

if (require.main === module) {
  ensureCallTypeGrants(parseArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-call-type-grants failed:", err);
      process.exitCode = 1;
    });
}
