/** Marca da plataforma (Bladr): a navalha que forma o "B". */
export function BladrMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="#15110D" />
      <g transform="translate(-11 0)">
        <path d="M170 104 H214 V408 H170 L150 388 V124 Z" fill="#F6F1E8" />
        <circle cx="192" cy="146" r="9" fill="#15110D" />
        <path d="M214 132 H286 A60 60 0 0 1 286 252 H214" fill="none" stroke="#F0A21B" strokeWidth="40" />
        <path d="M214 252 H300 A64 64 0 0 1 300 380 H214" fill="none" stroke="#F0A21B" strokeWidth="40" />
      </g>
    </svg>
  );
}
