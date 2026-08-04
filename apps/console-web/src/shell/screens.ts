import type { IconName } from './icons.js';

/*
 * The mockup's `NAV` table (brainstorm/mockup/Erria-outreach-agent-v07/outreach-console.html,
 * `const NAV = {...}`) — same keys, same icon/label/title/crumb copy. No `path` yet: there's no
 * router in this ticket, only the static sidebar/header chrome.
 */
export interface ScreenInfo {
  icon: IconName;
  label: string;
  title: string;
  crumb: string;
}

export const SCREENS = {
  queue: {
    icon: 'queue',
    label: 'Account Queue',
    title: 'Account Queue',
    crumb: 'Accounts the agent is working',
  },
  review: {
    icon: 'review',
    label: 'Review',
    title: 'Review Worklist',
    crumb: 'Drafts awaiting approval across all accounts',
  },
  escalation: {
    icon: 'escalation',
    label: 'Escalations',
    title: 'Escalations',
    crumb: 'Accounts that need a human response',
  },
  audit: {
    icon: 'audit',
    label: 'Audit Trail',
    title: 'Tier History',
    crumb: 'How each account earned its tier',
  },
  sendaudit: {
    icon: 'sample',
    label: 'Send Audit',
    title: 'Send Audit',
    crumb: 'Retrospective spot-check of Tier 1 autonomous sends',
  },
  settings: {
    icon: 'gear',
    label: 'Settings',
    title: 'Settings',
    crumb: 'Tune the system — basic, advanced, and locked policy controls',
  },
} as const satisfies Record<string, ScreenInfo>;

export type ScreenKey = keyof typeof SCREENS;
