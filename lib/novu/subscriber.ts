/**
 * Novu Subscriber Management
 * Syncs user data to Novu as subscribers using User.id as subscriberId.
 */
import { getNovuClient, isNovuConfigured } from "./client";

interface SubscriberData {
  userId: string;
  email: string;
  firstName: string;
  lastName?: string;
  phone?: string;
  avatar?: string;
  locale?: string;
}

/**
 * Sync a user to Novu as a subscriber.
 * The Novu `create` method automatically updates if the subscriber already exists.
 * Called on: registration, login (via API route), profile update.
 */
export async function syncSubscriber(data: SubscriberData): Promise<void> {
  if (!isNovuConfigured()) {
    console.warn("[Novu] Not configured, skipping subscriber sync");
    return;
  }

  try {
    const novu = getNovuClient();
    // create() will update an existing subscriber if the subscriberId matches
    await novu.subscribers.create({
      subscriberId: data.userId,
      firstName: data.firstName,
      lastName: data.lastName || "",
      email: data.email,
      phone: data.phone || undefined,
      avatar: data.avatar || undefined,
      locale: data.locale || "en",
    });
    console.log(`[Novu] Subscriber synced: ${data.userId}`);
  } catch (error) {
    console.error("[Novu] Failed to sync subscriber:", error);
  }
}

/**
 * Update subscriber notification channel and category preferences in Novu.
 * Channel prefs control which channels deliver notifications (email, in-app, push).
 * Category prefs control which types of notifications are sent at all.
 *
 * Category prefs are stored as subscriber custom data so Novu Dashboard
 * workflows can use them in conditional steps (e.g., skip email step if
 * subscriber.data.categoryAppointments === false).
 */
export async function updateSubscriberPreferences(
  userId: string,
  preferences: {
    // Channel preferences
    inApp?: boolean;
    email?: boolean;
    push?: boolean;
    // Category preferences (from NotificationPreference model)
    appointmentReminders?: boolean;
    paymentNotifications?: boolean;
    supportUpdates?: boolean;
    feedbackAlerts?: boolean;
    trialNotifications?: boolean;
    subscriptionAlerts?: boolean;
    marketingEmails?: boolean;
  },
): Promise<void> {
  if (!isNovuConfigured()) return;

  try {
    const novu = getNovuClient();
    await novu.subscribers.patch(
      {
        data: {
          // Channel preferences
          preferInApp: preferences.inApp ?? true,
          preferEmail: preferences.email ?? true,
          preferPush: preferences.push ?? false,
          // Category preferences — used in Novu Dashboard workflow conditions
          categoryAppointments: preferences.appointmentReminders ?? true,
          categoryPayments: preferences.paymentNotifications ?? true,
          categorySupport: preferences.supportUpdates ?? true,
          categoryFeedback: preferences.feedbackAlerts ?? true,
          categoryTrials: preferences.trialNotifications ?? true,
          categorySubscriptions: preferences.subscriptionAlerts ?? true,
          categoryMarketing: preferences.marketingEmails ?? false,
        },
      },
      userId,
    );
    console.log(`[Novu] Preferences updated for subscriber: ${userId}`);
  } catch (error) {
    console.error("[Novu] Failed to update subscriber preferences:", error);
  }
}

/**
 * Delete a subscriber from Novu (e.g. on account deletion).
 */
export async function deleteSubscriber(userId: string): Promise<void> {
  if (!isNovuConfigured()) return;

  try {
    const novu = getNovuClient();
    await novu.subscribers.delete(userId);
    console.log(`[Novu] Subscriber deleted: ${userId}`);
  } catch (error) {
    console.error("[Novu] Failed to delete subscriber:", error);
  }
}
