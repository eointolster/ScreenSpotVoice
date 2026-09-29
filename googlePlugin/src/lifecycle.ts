export type LifecycleEvent =
  | { kind: 'activated'; tabId: number }
  | { kind: 'removed'; tabId: number }
  | { kind: 'updated'; tabId: number; loading: boolean; urlChanged: boolean }
  | { kind: 'zoom'; tabId: number };

export function lifecycleAction(sharedTabId: number, event: LifecycleEvent): 'pause' | 'end' | 'none' {
  if (event.kind === 'activated') return event.tabId === sharedTabId ? 'none' : 'pause';
  if (event.tabId !== sharedTabId) return 'none';
  if (event.kind === 'removed') return 'end';
  if (event.kind === 'zoom') return 'pause';
  return event.loading || event.urlChanged ? 'end' : 'none';
}
