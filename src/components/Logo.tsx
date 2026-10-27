/** The WHAT IF LAB mark: a planet whose orbit is tilted off its "expected" plane. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <defs>
        <radialGradient id="lg-planet" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#eaf6ff" />
          <stop offset="0.45" stopColor="#41c7ff" />
          <stop offset="1" stopColor="#0b3d6e" />
        </radialGradient>
      </defs>
      <ellipse cx="32" cy="32" rx="28" ry="9" fill="none" stroke="#2b3540" strokeWidth="1.5" />
      <circle cx="32" cy="32" r="13" fill="url(#lg-planet)" />
      <ellipse cx="32" cy="32" rx="28" ry="9" fill="none" stroke="#41c7ff" strokeWidth="2" transform="rotate(-28 32 32)" strokeDasharray="44 132" strokeLinecap="round" />
      <circle cx="56.5" cy="19" r="3" fill="#eaf6ff" />
    </svg>
  );
}
