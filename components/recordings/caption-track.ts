export function buildCaptionTrackDataUri(
  transcriptText?: string | null,
): string {
  const cueBody = transcriptText?.trim() || "Session recording";
  const vtt = `WEBVTT\n\n00:00:00.000 --> 99:59:59.000\n${cueBody}\n`;
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
}
