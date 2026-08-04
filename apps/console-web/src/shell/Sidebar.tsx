import { NavItem } from './NavItem.js';
import { SCREENS, type ScreenKey } from './screens.js';

export function Sidebar({ active }: { active: ScreenKey }) {
  return (
    <aside className="rail">
      <div className="brand">
        <div className="brand-chip">
          <img src="/erria-logo.png" alt="Erria" />
        </div>
        <div>
          <div className="brand-name">Erria</div>
          <div className="brand-sub">Outreach Agent</div>
        </div>
      </div>

      <div className="nav-label">Workspace</div>
      <NavItem icon={SCREENS.queue.icon} label={SCREENS.queue.label} active={active === 'queue'} />
      <NavItem icon={SCREENS.review.icon} label={SCREENS.review.label} active={active === 'review'} />
      <NavItem
        icon={SCREENS.escalation.icon}
        label={SCREENS.escalation.label}
        active={active === 'escalation'}
        variant="attention"
      />
      <NavItem icon={SCREENS.audit.icon} label={SCREENS.audit.label} active={active === 'audit'} />

      <div className="nav-label">Admin</div>
      <NavItem icon={SCREENS.sendaudit.icon} label={SCREENS.sendaudit.label} active={active === 'sendaudit'} />

      <div className="rail-foot">
        <NavItem icon={SCREENS.settings.icon} label={SCREENS.settings.label} active={active === 'settings'} />
        <div className="rail-user">
          <div className="avatar">MT</div>
          <div>
            <div className="who">Minh Tran</div>
            <div className="role">AI Ops · BDR</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
