const OPS_CHAT_TIMEOUT_MS = 5_000;

/**
 * Posts `text` to the ops chat incoming webhook (Slack format; Discord's /slack
 * and Google Chat accept it too). No-op when SLACK_OPS_WEBHOOK_URL is unset.
 * Never throws and never logs the URL, which is itself the credential.
 */
export async function postOpsChat(text: string): Promise<boolean> {
  const url = process.env.SLACK_OPS_WEBHOOK_URL?.trim();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(OPS_CHAT_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[ops-chat] webhook answered ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn(
      "[ops-chat] post failed:",
      err instanceof Error ? err.name : "unknown",
    );
    return false;
  }
}
