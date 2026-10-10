// A spoken answer must describe what the app actually displayed.
export function reconcileAnswer(question: string, rawReply: unknown, highlightedLabel: string | null): string {
  const reply = String(rawReply || '').trim().slice(0, 600);
  const label = highlightedLabel?.trim().slice(0, 90) || 'the target';
  const saysMissing = /\b(?:(?:can't|cannot|couldn't|could not|unable to|don't|do not)\s+(?:find|see|locate|identify)|not found|not visible|there (?:is|are) no)\b/i.test(reply);
  if (highlightedLabel && (!reply || saysMissing)) return `I highlighted ${label} on your screen.`;
  if (!reply) return 'I could not locate that target on the current screen.';
  const claimsBox = /\b(?:highlighted|outlined|boxed)\b/i.test(reply);
  if (!highlightedLabel && claimsBox) return 'I could not place a box on this screen. Try asking about a larger visible target.';
  return reply;
}
