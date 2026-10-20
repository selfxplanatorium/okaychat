// Drawn 👀 for the TeaTree Chat theme name. The colors are fixed like a real emoji's, so it reads
// the same in every theme and does not depend on an emoji font being installed.
export function EyesMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 36 36">
      <ellipse cx={11.5} cy={18} rx={8} ry={11.5} fill="#fff" stroke="#14171a" strokeWidth={2} />
      <ellipse cx={8} cy={18.5} rx={3.1} ry={4.6} fill="#14171a" />
      <circle cx={8.9} cy={16.4} r={1.1} fill="#fff" />
      {/* The right eye is drawn last so it overlaps the left one, as in the emoji. */}
      <ellipse cx={24.5} cy={18} rx={8} ry={11.5} fill="#fff" stroke="#14171a" strokeWidth={2} />
      <ellipse cx={21} cy={18.5} rx={3.1} ry={4.6} fill="#14171a" />
      <circle cx={21.9} cy={16.4} r={1.1} fill="#fff" />
    </svg>
  );
}
