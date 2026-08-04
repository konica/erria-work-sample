import { Icon, type IconName } from './icons.js';

export interface NavItemProps {
  icon: IconName;
  label: string;
  active: boolean;
  variant?: 'attention';
}

export function NavItem({ icon, label, active, variant }: NavItemProps) {
  const className = ['nav-item', active ? 'active' : null, variant ?? null].filter(Boolean).join(' ');
  return (
    <button type="button" className={className}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}
