// Kept in its own module (no imports) so that PrismaModule and any provider that
// needs to @Inject(PRISMA) — e.g. PrismaShutdownService — can both depend on this
// token without forming an import cycle with prisma.module.ts.
export const PRISMA = Symbol('PRISMA');
