/**
 * Read-only detector for the Stream control plane. It compares the live Stream
 * app with `control-plane-contract.ts` and never writes to Stream; the
 * `--apply` ensure scripts are the only writers.
 */
import {
  CO_PRESENTER_CALL_ROLE,
  STREAM_CALL_TYPE,
} from "@/lib/stream/call-cid";
import {
  SORTED_DESIRED_EVENT_TYPES,
  TARGET_APP_SETTINGS,
  TARGET_INACTIVITY_TIMEOUT_SECONDS,
  UNUSED_CALL_TYPES,
  evaluateHookDrift,
  expectedWebhookUrl,
  grantDifferences,
  hardenedUnusedTypeGrants,
  hookAccepts,
  intendedDefaultCallTypeGrants,
  matchesCoPresenterGrants,
  productFor,
  type HookLike,
} from "@/lib/stream/control-plane-contract";
import { getStreamVideoClient, isStreamConfigured } from "@/lib/stream-client";
import { reportSentryMessage } from "@/lib/observability/report";

interface CallTypeSnapshot {
  grants: Record<string, string[]>;
  settings?: { session?: { inactivity_timeout_seconds?: number } };
}

/** The slice of the Stream node client the detector reads. */
export interface ControlPlaneReader {
  getApp(): Promise<{
    app: {
      guest_user_creation_disabled?: boolean;
      event_hooks?: HookLike[];
      webhook_url?: string;
      webhook_events?: string[];
    };
  }>;
  listRoles(): Promise<{ roles: { name: string }[] }>;
  video: {
    getCallType(req: { name: string }): Promise<CallTypeSnapshot>;
  };
}

export interface ControlPlaneDriftResult {
  drifted: boolean;
  /** Stable keys only (ids, role and permission names); never URLs or secrets. */
  findings: string[];
  /** Contract items that cannot be read back from Stream or lack an input. */
  unverified: string[];
}

function webhookFindings(
  app: Awaited<ReturnType<ControlPlaneReader["getApp"]>>["app"],
  expectedUrl: string | undefined,
): string[] {
  const findings: string[] = [];
  const hooks = (app.event_hooks ?? []).filter(
    (h) => h.hook_type === "webhook" && typeof h.id === "string",
  );
  if (hooks.length === 0) findings.push("webhook:none");

  const unplaceable = new Set(SORTED_DESIRED_EVENT_TYPES);
  for (const hook of hooks) {
    const eligible = SORTED_DESIRED_EVENT_TYPES.filter((t) =>
      hookAccepts(hook, t),
    );
    for (const t of eligible) unplaceable.delete(t);
    if (eligible.length === 0) continue;

    const drift = evaluateHookDrift(hook, eligible, expectedUrl);
    const id = `webhook:${hook.id}`;
    if (drift.disabled) findings.push(`${id}:disabled`);
    if (drift.urlMismatch) findings.push(`${id}:url`);
    if (drift.receivesAll) findings.push(`${id}:wildcard`);
    for (const t of drift.missing) findings.push(`${id}:missing:${t}`);
    for (const t of drift.extra) findings.push(`${id}:extra:${t}`);
  }
  if (hooks.length > 0) {
    for (const t of unplaceable) {
      findings.push(`webhook:unplaceable:${productFor(t)}:${t}`);
    }
  }

  const legacyActive = Boolean(app.webhook_url?.trim());
  if (legacyActive && (app.webhook_events ?? []).includes("*")) {
    findings.push("webhook:legacy_v1_wildcard");
  }
  return findings;
}

function defaultCallTypeFindings(
  callType: CallTypeSnapshot,
  roleNames: Set<string>,
): string[] {
  const findings = grantDifferences(
    callType.grants,
    intendedDefaultCallTypeGrants(callType.grants),
  ).map((d) => `call_type:${STREAM_CALL_TYPE}:grant:${d}`);

  if (
    callType.settings?.session?.inactivity_timeout_seconds !==
    TARGET_INACTIVITY_TIMEOUT_SECONDS
  ) {
    findings.push(`call_type:${STREAM_CALL_TYPE}:inactivity_timeout`);
  }
  if (!roleNames.has(CO_PRESENTER_CALL_ROLE)) {
    findings.push(`role:${CO_PRESENTER_CALL_ROLE}:missing`);
  }
  if (!matchesCoPresenterGrants(callType.grants[CO_PRESENTER_CALL_ROLE])) {
    findings.push(
      `call_type:${STREAM_CALL_TYPE}:grant:${CO_PRESENTER_CALL_ROLE}:differs`,
    );
  }
  return findings;
}

export async function detectStreamControlPlaneDrift(
  opts: { client?: ControlPlaneReader; appUrl?: string } = {},
): Promise<ControlPlaneDriftResult> {
  const client = opts.client ?? configuredClient();
  const appUrl = (opts.appUrl ?? process.env.NEXT_PUBLIC_APP_URL)?.trim();
  const unverified = ["app:enable_hook_payload_compression"];
  if (!appUrl) unverified.push("webhook:url");

  const [{ app }, { roles }, defaultType, ...unusedTypes] = await Promise.all([
    client.getApp(),
    client.listRoles(),
    client.video.getCallType({ name: STREAM_CALL_TYPE }),
    ...UNUSED_CALL_TYPES.map((name) => client.video.getCallType({ name })),
  ]);

  const findings = [
    ...webhookFindings(app, appUrl ? expectedWebhookUrl(appUrl) : undefined),
    ...(app.guest_user_creation_disabled ===
    TARGET_APP_SETTINGS.guestUserCreationDisabled
      ? []
      : ["app:guest_user_creation_disabled"]),
    ...defaultCallTypeFindings(defaultType, new Set(roles.map((r) => r.name))),
    ...unusedTypes.flatMap((callType, i) =>
      grantDifferences(
        callType.grants,
        hardenedUnusedTypeGrants(callType.grants),
      ).map((d) => `call_type:${UNUSED_CALL_TYPES[i]}:grant:${d}`),
    ),
  ];

  const result = { drifted: findings.length > 0, findings, unverified };
  if (result.drifted) {
    reportSentryMessage(
      `Stream control plane drifted from the checked-in contract (${findings.length} finding(s))`,
      {
        subsystem: "stream",
        op: "control-plane-drift",
        level: "error",
        extra: { findings },
        fingerprint: ["stream-control-plane-drift"],
      },
    );
  }
  return result;
}

function configuredClient(): ControlPlaneReader {
  if (!isStreamConfigured()) {
    throw new Error("Stream is not configured: STREAM_API_KEY/SECRET missing");
  }
  return getStreamVideoClient();
}
