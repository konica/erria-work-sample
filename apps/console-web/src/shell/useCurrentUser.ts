import { useEffect, useState } from 'react';

export interface CurrentUser {
  sub: string;
  name: string;
  roles: string[];
}

export function useCurrentUser(): CurrentUser | null {
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then((response) => {
        if (!response.ok) throw new Error(`GET /api/me failed: ${response.status}`);
        return response.json();
      })
      .then((body: CurrentUser) => setUser(body))
      .catch((err: unknown) => console.error('Failed to load current user', err));
  }, []);

  return user;
}
