import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setUnauthorisedHandler, tokenStore } from './api/client';
import type { Me } from './api/types';

interface AuthState {
  token: string | null;
  me: Me | undefined;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => tokenStore.get());

  const signOut = useCallback(() => {
    tokenStore.set(null);
    setToken(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorisedHandler(signOut);
  }, [signOut]);

  const me = useQuery({ queryKey: ['me', token], queryFn: api.me, enabled: token !== null });

  const value = useMemo<AuthState>(
    () => ({
      token,
      me: me.data,
      async login(email, password) {
        const res = await api.login(email, password);
        tokenStore.set(res.token);
        setToken(res.token);
      },
      async logout() {
        try {
          await api.logout();
        } finally {
          signOut();
        }
      },
    }),
    [token, me.data, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
