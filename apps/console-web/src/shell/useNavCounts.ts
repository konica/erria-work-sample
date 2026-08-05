import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

export interface NavCounts {
  review: number;
  escalation: number;
}

export function useNavCounts(): NavCounts | null {
  const [counts, setCounts] = useState<NavCounts | null>(null);

  useEffect(() => {
    apiFetch('/api/nav-counts')
      .then((response) => {
        if (!response.ok) throw new Error(`GET /api/nav-counts failed: ${response.status}`);
        return response.json();
      })
      .then((body: NavCounts) => setCounts(body))
      .catch((err: unknown) => console.error('Failed to load nav counts', err));
  }, []);

  return counts;
}
