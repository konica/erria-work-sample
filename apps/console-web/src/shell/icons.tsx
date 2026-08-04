import type { ReactNode, SVGProps } from 'react';

/*
 * Nav icon paths, copied verbatim from the mockup's inline `I` icon map
 * (brainstorm/mockup/Erria-outreach-agent-v07/outreach-console.html, the `const I = {...}` block).
 * Only the icons this ticket's shell actually renders are ported — the rest belong to screens
 * that don't exist yet.
 */
export type IconName =
  | 'queue'
  | 'review'
  | 'escalation'
  | 'audit'
  | 'sample'
  | 'gear'
  | 'moon'
  | 'sun'
  | 'ship'
  | 'info'
  | 'arrow'
  | 'user'
  | 'building'
  | 'spark'
  | 'pencil'
  | 'check'
  | 'checkc'
  | 'x'
  | 'xc'
  | 'robot';

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
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  user: (
    <>
      <circle cx={12} cy={8} r={4} />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
      <path d="M15 9h4a1 1 0 0 1 1 1v11" />
      <path d="M8 8h.01M8 12h.01M8 16h.01M11 8h.01M11 12h.01M11 16h.01" />
    </>
  ),
  spark: (
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  ),
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  checkc: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  xc: (
    <>
      <circle cx={12} cy={12} r={9} />
      <path d="m15 9-6 6M9 9l6 6" />
    </>
  ),
  robot: (
    <>
      <rect x={4} y={8} width={16} height={12} rx={2} />
      <path d="M12 4v4M9 14h.01M15 14h.01M2 13v2M22 13v2" />
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
