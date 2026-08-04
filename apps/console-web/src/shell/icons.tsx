import type { ReactNode, SVGProps } from 'react';

/*
 * Nav icon paths, copied verbatim from the mockup's inline `I` icon map
 * (brainstorm/mockup/Erria-outreach-agent-v07/outreach-console.html, the `const I = {...}` block).
 * Only the icons this ticket's shell actually renders are ported — the rest belong to screens
 * that don't exist yet.
 */
export type IconName = 'queue' | 'review' | 'escalation' | 'audit' | 'sample' | 'gear' | 'moon' | 'sun' | 'ship' | 'info';

const PATHS: Record<IconName, ReactNode> = {
  queue: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx={3.5} cy={6} r={1.2} />
      <circle cx={3.5} cy={12} r={1.2} />
      <circle cx={3.5} cy={18} r={1.2} />
    </>
  ),
  review: <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />,
  escalation: (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v5" />
      <path d="M12 18h.01" />
    </>
  ),
  audit: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M12 7v5l3 2" />
    </>
  ),
  sample: (
    <>
      <path d="M3 3v18h18" />
      <rect x={7} y={12} width={3} height={6} />
      <rect x={12} y={8} width={3} height={10} />
      <rect x={17} y={5} width={3} height={13} />
    </>
  ),
  gear: (
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  sun: (
    <>
      <circle cx={12} cy={12} r={4} />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </>
  ),
  ship: (
    <>
      <path d="M3 15l2 5h14l2-5" />
      <path d="M4 15V9l8-3 8 3v6" />
      <path d="M12 6V3" />
    </>
  ),
  info: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </>
  ),
};

export function Icon({ name, ...svgProps }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...svgProps}
    >
      {PATHS[name]}
    </svg>
  );
}
