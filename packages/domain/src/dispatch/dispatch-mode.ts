export const DISPATCH_MODES = ['sandbox', 'graph'] as const;
export type DispatchMode = (typeof DISPATCH_MODES)[number];

export interface ResolveDispatchModeDeps {
  warn: (message: string) => void;
}

/**
 * A missing/empty/unrecognised `MESSAGE_DISPATCH_MODE` must never resolve to `graph` — the
 * console is publicly reachable and a real send is the one failure mode this system can't take
 * back (ADR-0007). Absent config degrades to `sandbox`; garbage config fails startup instead of
 * guessing.
 */
export function resolveDispatchMode(
  rawValue: string | undefined,
  deps: ResolveDispatchModeDeps,
): DispatchMode {
  const trimmed = (rawValue ?? '').trim();

  if (trimmed === '') {
    deps.warn(
      "MESSAGE_DISPATCH_MODE is not set (or blank) — defaulting to 'sandbox'. Set it explicitly " +
        'in .env to silence this warning.',
    );
    return 'sandbox';
  }

  if ((DISPATCH_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as DispatchMode;
  }

  throw new Error(
    `Unrecognised MESSAGE_DISPATCH_MODE '${rawValue}'. Expected one of: ${DISPATCH_MODES.join(', ')}.`,
  );
}
