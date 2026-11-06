export const primaryViews = ['recorder', 'review', 'editor', 'library', 'settings'] as const;
export type PrimaryView = (typeof primaryViews)[number];
export function isPrimaryView(view: unknown): view is PrimaryView {
  return typeof view === 'string' && primaryViews.some((value) => value === view);
}
export function windowKey(view: string) {
  return isPrimaryView(view) ? 'recorder' : view;
}
