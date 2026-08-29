/** The Bay — three beams, two bays, a card in each. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect x="6" y="6" width="9" height="52" rx="2.5" fill="var(--beam)" />
      <rect x="27.5" y="6" width="9" height="52" rx="2.5" fill="var(--beam)" />
      <rect x="49" y="6" width="9" height="52" rx="2.5" fill="var(--beam)" />
      <rect x="16.5" y="33" width="9.5" height="10" rx="2" fill="var(--ink)" />
      <rect x="38" y="17" width="9.5" height="10" rx="2" fill="var(--ink)" />
    </svg>
  );
}
