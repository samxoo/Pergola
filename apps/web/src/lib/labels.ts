/**
 * The label palette.
 *
 * Labels are stored as colour *names*, never hex, so the palette can be retuned
 * without a data migration. These are muted to sit alongside verdigris rather
 * than fight it — a board covered in saturated chips is unreadable.
 */
export const LABEL_COLORS = {
  green: "#4C8A52",
  yellow: "#B08A1E",
  orange: "#C2691F",
  red: "#A34734",
  purple: "#7A4F9E",
  blue: "#3B5FA6",
} as const;

export type LabelColor = keyof typeof LABEL_COLORS;

export const LABEL_NAMES = Object.keys(LABEL_COLORS) as LabelColor[];

export const hexFor = (color: string): string =>
  LABEL_COLORS[color as LabelColor] ?? "#5D6679";

/** Initials for an avatar chip, from a display name or an email. */
export function initials(nameOrEmail: string): string {
  const clean = nameOrEmail.trim();
  if (!clean) return "?";
  const parts = clean.split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** A stable colour per person, so the same face keeps the same chip. */
export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return Object.values(LABEL_COLORS)[h % 6]!;
}
