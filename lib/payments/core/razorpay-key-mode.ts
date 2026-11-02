/** A Razorpay key's mode from its id prefix; a leaf module, so probes import it without the SDK. */
type RazorpayKeyMode = "live" | "test" | "unset" | "unrecognised";

export function razorpayKeyMode(keyId: string | undefined): RazorpayKeyMode {
  const id = keyId?.trim();
  if (!id) return "unset";
  if (id.startsWith("rzp_live_")) return "live";
  if (id.startsWith("rzp_test_")) return "test";
  return "unrecognised";
}

/** Live collection keys are the launch line: before them no customer money moves. */
export function collectionsAreLive(): boolean {
  return razorpayKeyMode(process.env.RAZORPAY_KEY_ID) === "live";
}
