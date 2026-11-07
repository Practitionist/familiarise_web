const RETRY_DELAY_MS = 2_000;

async function ping(meetingId: string): Promise<void> {
  const url = `/api/meetings/${encodeURIComponent(meetingId)}/host-live`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: "POST" });
      if (res.status < 500) return;
    } catch {
      // A network failure gets the one retry below, like a 5xx.
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

/** Tells the server the host is in the call: best effort, one retry, never awaited by the join. */
export function pingHostLive(meetingId: string): void {
  void ping(meetingId);
}
