/**
 * When something happened, with the clock on it.
 *
 * "Sep 12" tells you a comment is from last week; it does not tell you whether
 * it came before or after the call. So every timestamp carries hours and
 * minutes, and only the date part is abbreviated: today and yesterday by name,
 * the rest by day and month, with the year once it is no longer this one.
 */

type T = (key: string, params?: Record<string, string | number>) => string;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today, 14:32" · "Yesterday, 09:10" · "Sep 12, 14:32" · "Sep 12, 2025, 14:32". */
export function formatWhen(iso: string, t: T, locale: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

  if (sameDay(d, now)) return `${t("Today")}, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `${t("Yesterday")}, ${time}`;

  const day = d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

/** The whole thing, for a tooltip: weekday, full date, time. */
export function formatExact(iso: string, locale: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
