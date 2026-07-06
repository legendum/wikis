import { useEffect } from "react";

/**
 * Set `document.title` while mounted; restore the previous title on
 * unmount. Pass the full computed title — this hook does no formatting.
 *
 * Captures whatever `document.title` was at mount as the restore value,
 * so the consumer's `<title>` tag in the HTML shell is the source of
 * truth for the app's default and pues doesn't need to know it.
 */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
