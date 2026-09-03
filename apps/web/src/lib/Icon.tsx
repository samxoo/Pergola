/**
 * The handful of line icons the card actions use.
 *
 * Inline SVG rather than an icon font or a dependency: six shapes do not
 * justify either, and drawing them with `currentColor` means they inherit
 * whatever the button is doing — hover, disabled, light theme, dark theme —
 * without a second set of colours to keep in step.
 */
export type IconName =
  | "tag"
  | "user"
  | "clock"
  | "image"
  | "vote"
  | "archive"
  | "reply"
  | "plus"
  | "undo"
  | "redo"
  | "boards"
  | "import";

const PATHS: Record<IconName, React.ReactNode> = {
  tag: (
    <>
      <path d="M2.5 7.2V2.5h4.7l6.3 6.3-4.7 4.7L2.5 7.2Z" />
      <circle cx="5.4" cy="5.4" r="1.05" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M3 13.5a5 5 0 0 1 10 0" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.9V8l2.2 1.6" />
    </>
  ),
  image: (
    <>
      <rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.4" />
      <path d="m3.6 11 3-3 2.4 2.2 1.8-1.6 1.6 1.5" />
      <circle cx="6" cy="6.4" r="1" />
    </>
  ),
  vote: <path d="M8 3.2 13 9.4H9.9v3.4H6.1V9.4H3L8 3.2Z" />,
  archive: (
    <>
      <rect x="2.4" y="3.2" width="11.2" height="3" rx="0.9" />
      <path d="M3.5 6.2v6a1.3 1.3 0 0 0 1.3 1.3h6.4a1.3 1.3 0 0 0 1.3-1.3v-6" />
      <path d="M6.6 9h2.8" />
    </>
  ),
  reply: <path d="M6.4 4 2.6 7.6l3.8 3.6V9c3.4 0 5.4 1 6.6 3 .2-4.4-2-6.6-6.6-6.8V4Z" />,
  plus: <path d="M8 3.4v9.2M3.4 8h9.2" />,
  undo: (
    <>
      <path d="M3 8.4h6.1a3.3 3.3 0 0 1 0 6.6H6" />
      <path d="M5.6 5.8 3 8.4l2.6 2.6" />
    </>
  ),
  redo: (
    <>
      <path d="M13 8.4H6.9a3.3 3.3 0 0 0 0 6.6H10" />
      <path d="m10.4 5.8 2.6 2.6-2.6 2.6" />
    </>
  ),
  boards: (
    <>
      <rect x="2.4" y="2.8" width="3.2" height="10.4" rx="0.9" />
      <rect x="6.4" y="2.8" width="3.2" height="7" rx="0.9" />
      <rect x="10.4" y="2.8" width="3.2" height="8.6" rx="0.9" />
    </>
  ),
  import: (
    <>
      <path d="M8 2.6v7.4M5.2 7.4 8 10.2l2.8-2.8" />
      <path d="M2.8 10.8v1.4a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2v-1.4" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `ic ${className}` : "ic"}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
