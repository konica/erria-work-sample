import { NavItem } from './NavItem.js';
import { SCREENS, type ScreenKey } from './screens.js';
import { useNavCounts } from './useNavCounts.js';
import { useCurrentUser } from './useCurrentUser.js';

export function Sidebar({
  active,
  onNavigate,
}: {
  active: ScreenKey;
  onNavigate?: (screen: ScreenKey) => void;
}) {
  const counts = useNavCounts();
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.roles?.includes('admin') ?? false;

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
      <NavItem
        icon={SCREENS.queue.icon}
        label={SCREENS.queue.label}
        active={active === 'queue'}
        onClick={onNavigate ? () => onNavigate('queue') : undefined}
      />
      <NavItem
        icon={SCREENS.review.icon}
        label={SCREENS.review.label}
        active={active === 'review'}
        count={counts?.review}
      />
      <NavItem
        icon={SCREENS.escalation.icon}
        label={SCREENS.escalation.label}
        active={active === 'escalation'}
        variant="attention"
        count={counts?.escalation}
      />
      <NavItem icon={SCREENS.audit.icon} label={SCREENS.audit.label} active={active === 'audit'} />

      <div className="nav-label">Admin</div>
      <NavItem
        icon={SCREENS.sendaudit.icon}
        label={SCREENS.sendaudit.label}
        active={active === 'sendaudit'}
        onClick={onNavigate ? () => onNavigate('sendaudit') : undefined}
      />

      <div className="rail-foot">
        {isAdmin && (
          <NavItem
            icon={SCREENS.settings.icon}
            label={SCREENS.settings.label}
            active={active === 'settings'}
            onClick={onNavigate ? () => onNavigate('settings') : undefined}
          />
        )}
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
