/**
 * Enforces least-privilege role grants on `STREAM_CALL_TYPE` (`default`),
 * revoking unguarded join, end-call, join-ended-call, update-call-permissions,
 * and all 18 billable permissions (including `-owner` and `-any-team` variants)
 * from client roles.
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
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import { canonical } from "../../lib/stream/config-fingerprint";
import {
  anyOpenCallMemberHolds,
  MEMBER_ROLE,
} from "./backfill-call-member-role";
import {
  BILLABLE_PERMISSIONS,
  matchesPermissionWithScope,
} from "./harden-unused-call-types";

const JOIN_CALL = "join-call";
const JOIN_REVOKED_ROLES = ["user", "guest"];
const END_CALL = "end-call";
const CALL_CONTROL_REVOKED_PERMISSIONS = [
  END_CALL,
  "join-ended-call",
  "update-call-permissions",
];
export const DEFAULT_CALL_TYPE_REVOKED_PERMISSIONS = [
  ...BILLABLE_PERMISSIONS,
  ...CALL_CONTROL_REVOKED_PERMISSIONS,
];
const RECORDING_REVOKED_ROLES = [...JOIN_REVOKED_ROLES, MEMBER_ROLE];

export function isRevokedClientPermission(perm: string): boolean {
  return matchesPermissionWithScope(
    perm,
    DEFAULT_CALL_TYPE_REVOKED_PERMISSIONS,
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
      argv.includes("--join-route-is-deployed"),
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

async function requireSomeoneHoldsMemberRole(
  client: ReturnType<typeof getStreamVideoClient>,
  opts: EnsureCallTypeGrantsOptions,
): Promise<boolean> {
  if (!opts.apply || opts.restore) return true;

  let scan: Awaited<ReturnType<typeof anyOpenCallMemberHolds>>;
  try {
    scan = await anyOpenCallMemberHolds(client, MEMBER_ROLE);
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
      `\nacross ${scan.callsWithUncoveredMembers.length} call(s) do NOT hold \`${MEMBER_ROLE}\`.` +
      (scan.callsWithUncoveredMembers.length > 0
        ? `\n\nAffected calls: ${scan.callsWithUncoveredMembers.slice(0, 10).join(", ")}` +
          (scan.callsWithUncoveredMembers.length > 10
            ? ` … and ${scan.callsWithUncoveredMembers.length - 10} more`
            : ``)
        : ``) +
      `\n\nBackfill the role first, then re-run:` +
      `\n  npx tsx scripts/stream/backfill-call-member-role.ts --apply\n`,
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

  const grants: Record<string, string[]> = { ...existing.grants };
  const before = JSON.stringify(grants, null, 2);

  if (opts.restore) {
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants && !roleGrants.includes(JOIN_CALL)) {
        grants[role] = [...roleGrants, JOIN_CALL];
      }
    }
    const restoreMember = grants[MEMBER_ROLE];
    if (restoreMember && !restoreMember.includes(END_CALL)) {
      grants[MEMBER_ROLE] = [...restoreMember, END_CALL];
    }
  } else {
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter(
          (g) =>
            !matchesPermissionWithScope(g, [JOIN_CALL]) &&
            !isRevokedClientPermission(g),
        );
      }
    }

    for (const role of RECORDING_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter((g) => !isRevokedClientPermission(g));
      }
    }

    const memberGrants = grants[MEMBER_ROLE] ?? [];
    if (!memberGrants.includes(JOIN_CALL)) {
      grants[MEMBER_ROLE] = [...memberGrants, JOIN_CALL];
    }
  }

  const after = JSON.stringify(grants, null, 2);

  if (before === after) {
    console.log(
      `✅ call type "${STREAM_CALL_TYPE}" already has the desired grants — no change`,
    );
    return 0;
  }

  console.log(`Call type: ${STREAM_CALL_TYPE}`);
  for (const role of [...JOIN_REVOKED_ROLES, MEMBER_ROLE, "admin"]) {
    const had = (existing.grants[role] ?? []).includes(JOIN_CALL);
    const now = (grants[role] ?? []).includes(JOIN_CALL);
    console.log(
      `  ${role.padEnd(12)} join-call: ${had} → ${now}` +
        (grants[role] ? "" : "   (role absent on this call type)"),
    );
  }
  for (const role of RECORDING_REVOKED_ROLES) {
    for (const perm of DEFAULT_CALL_TYPE_REVOKED_PERMISSIONS) {
      const had = (existing.grants[role] ?? []).includes(perm);
      const now = (grants[role] ?? []).includes(perm);
      if (had === now && !had) continue;
      console.log(`  ${role.padEnd(12)} ${perm.padEnd(28)}: ${had} → ${now}`);
    }
  }

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  const settingsBefore = canonical(existing.settings);
  const notificationsBefore = canonical(existing.notification_settings);

  await client.video.updateCallType({ name: STREAM_CALL_TYPE, grants });

  const verify = await client.video.getCallType({ name: STREAM_CALL_TYPE });
  const settingsAfter = canonical(verify.settings);
  const notificationsAfter = canonical(verify.notification_settings);

  if (
    !opts.restore &&
    !(verify.grants[MEMBER_ROLE] ?? []).includes(JOIN_CALL)
  ) {
    console.error(
      `\n🚨 ${MEMBER_ROLE} does NOT hold ${JOIN_CALL} on Stream after this write.`,
    );
    return 1;
  }

  if (
    !opts.restore &&
    (verify.grants[MEMBER_ROLE] ?? []).some((g) => isRevokedClientPermission(g))
  ) {
    console.error(
      `\n🚨 ${MEMBER_ROLE} still holds a revoked control or billable permission on Stream after this write.`,
    );
    return 1;
  }

  if (
    opts.restore &&
    (grants[MEMBER_ROLE] ?? []).includes(END_CALL) &&
    !(verify.grants[MEMBER_ROLE] ?? []).includes(END_CALL)
  ) {
    console.error(
      `\n🚨 ${MEMBER_ROLE} still lacks ${END_CALL} on Stream after the rollback.`,
    );
    return 1;
  }

  if (
    settingsAfter !== settingsBefore ||
    notificationsAfter !== notificationsBefore
  ) {
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
    return 1;
  }

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
