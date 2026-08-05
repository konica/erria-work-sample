export * from './generated/prisma/client.js';
export { prisma } from './client.js';
export { upsertAccount, upsertVessel, upsertContact } from './seed/upsert-entities.js';
export type {
  UpsertAccountInput,
  UpsertVesselInput,
  UpsertContactInput,
} from './seed/upsert-entities.js';
