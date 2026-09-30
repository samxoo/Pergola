import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept current as the window changes.
 *
 * For the few places where a narrow screen needs different *structure* — a
 * control that moves to another bar, three buttons folded into one menu. Size
 * and spacing stay in the stylesheet, where they belong.
 */
export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/**
 * Narrower than the full top bar, which needs about 1100px: a tablet, or a
 * laptop window beside another. Words become icons and the account controls
 * fold into one menu.
 */
export const FOLDED = "(max-width: 1180px)";

/** Phone-sized: on top of that, undo moves down to the view bar. */
export const COMPACT = "(max-width: 720px)";
