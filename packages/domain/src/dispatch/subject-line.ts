export interface SubjectLineInput {
  companyName: string;
  vesselName: string | null;
  triggerCategory: string | null;
}

/**
 * Follows the pattern spec §6 illustrates — "Quick note on MV Song Hong Pioneer's life-raft service
 * window". The conversational opener is deliberate, not decoration: it reads as a person writing,
 * which is the same thing §5's named-human signature and low-pressure close are protecting.
 * Isolated here so the wording can be revised in one place.
 */
export function buildSubjectLine(input: SubjectLineInput): string {
  const subject = input.vesselName ?? input.companyName;
  return input.triggerCategory
    ? `Quick note on ${possessive(subject)} ${input.triggerCategory}`
    : `Quick note on ${subject}`;
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}
