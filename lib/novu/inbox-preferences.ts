import type { InboxRestrictions } from "@/schemas/inbox-preferences";
import { FAMILIES } from "./templates/families";
import { getNovuClient, isNovuConfigured } from "./client";
import { syncSubscriber } from "./subscriber";

const ownedFamilies = new Set<string>(FAMILIES.map((family) => family.id));

export async function readInboxRestrictions(
  userId: string,
): Promise<InboxRestrictions> {
  if (!isNovuConfigured()) throw new Error("Inbox preferences unavailable");
  const { result } = await getNovuClient().subscribers.preferences.list({
    subscriberId: userId,
    criticality: "all",
  });
  return {
    globalMuted:
      !result.global.enabled || result.global.channels.inApp === false,
    workflows: result.workflows.flatMap((item) => {
      const id = [item.workflow.identifier, item.workflow.slug].find((value) =>
        ownedFamilies.has(value),
      );
      return id && (!item.enabled || item.channels.inApp === false)
        ? [{ id, name: item.workflow.name }]
        : [];
    }),
  };
}

/** Only an explicit account-owner confirmation replaces older inbox-only restrictions. */
export async function adoptFamiliariseInboxSettings(
  userId: string,
): Promise<InboxRestrictions> {
  if (!(await syncSubscriber(userId)))
    throw new Error("Inbox synchronization unavailable");
  const restrictions = await readInboxRestrictions(userId);
  const api = getNovuClient().subscribers.preferences;
  if (restrictions.workflows.length > 0)
    await api.bulkUpdate(
      {
        preferences: restrictions.workflows.map((workflow) => ({
          workflowId: workflow.id,
          channels: { inApp: true },
        })),
      },
      userId,
    );
  if (restrictions.globalMuted)
    await api.update({ channels: { inApp: true } }, userId);
  return readInboxRestrictions(userId);
}
