import { useSyncExternalStore } from 'react';
import { getSnapshot, login, logout, subscribe, type AuthState } from './authStore.js';

export function useAuth(): AuthState & { login: () => Promise<void>; logout: () => Promise<void> } {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return { ...state, login, logout };
}
