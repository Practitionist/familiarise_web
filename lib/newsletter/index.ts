/**
 * Newsletter Service
 *
 * Barrel export for newsletter functionality.
 * Currently uses Resend for sending; will switch to ConvertKit (Issue #334)
 * when subscriber count reaches 500+.
 */

export {
  syncToConvertKit,
  removeFromConvertKit,
  tagSubscriber,
  createBroadcast,
} from "./convertkit";

export {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
} from "./unsubscribe";
