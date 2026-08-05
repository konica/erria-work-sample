import { Icon } from './icons.js';
import { useAuth } from '../auth/useAuth.js';

export function LogoutButton() {
  const { logout } = useAuth();

  return (
    <button type="button" className="theme-toggle" onClick={() => void logout()} aria-label="Log out">
      <Icon name="logout" />
    </button>
  );
}
