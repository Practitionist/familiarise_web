import type { Channel } from "stream-chat";

/** Appends a page without repeating a channel the list already holds. */
export function appendUniqueChannels(
  prev: Channel[],
  page: Channel[],
): Channel[] {
  const seen = new Set(prev.map((ch) => ch.cid));
  const fresh = page.filter((ch) => {
    if (seen.has(ch.cid)) return false;
    seen.add(ch.cid);
    return true;
  });
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
}

/** Puts a channel first unless the list already holds its cid. */
export function insertChannelAtTop(
  prev: Channel[],
  channel: Channel,
): Channel[] {
  return prev.some((ch) => ch.cid === channel.cid) ? prev : [channel, ...prev];
}
