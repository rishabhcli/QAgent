import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { GitHubUser, SessionData } from '@/lib/types';
import { API_URL } from '@/lib/api/client';

// Required for AuthSession to work properly
WebBrowser.maybeCompleteAuthSession();

const GITHUB_CLIENT_ID = process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID || '';
const TOKEN_KEY = 'qagent_access_token';
const USER_KEY = 'qagent_user';

// GitHub OAuth discovery document
const discovery = {
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  revocationEndpoint: `https://github.com/settings/connections/applications/${GITHUB_CLIENT_ID}`,
};

interface AuthContextType {
  user: GitHubUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Generate OAuth redirect URI
  const redirectUri = AuthSession.makeRedirectUri({
    scheme: 'qagent',
    path: 'auth/callback',
  });

  // OAuth request configuration
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GITHUB_CLIENT_ID,
      scopes: ['read:user', 'user:email', 'repo'],
      redirectUri,
    },
    discovery
  );

  // Load stored session on app start
  useEffect(() => {
    loadStoredSession();
  }, []);

  // Handle OAuth response
  useEffect(() => {
    if (response?.type === 'success') {
      const { code, state } = response.params;

      if (!request?.codeVerifier || !request?.state || state !== request.state) {
        console.error('OAuth state/PKCE validation failed');
        setIsLoading(false);
        return;
      }

      exchangeCodeForToken(code, request.codeVerifier, request.state);
    } else if (response?.type === 'error') {
      console.error('OAuth error:', response.error);
      setIsLoading(false);
    }
  }, [request, response]);

  const loadStoredSession = async () => {
    try {
      const storedToken = await SecureStore.getItemAsync(TOKEN_KEY);
      const storedUser = await SecureStore.getItemAsync(USER_KEY);

      if (storedToken && storedUser) {
        setAccessToken(storedToken);
        setUser(JSON.parse(storedUser));
        
        // Validate token is still valid
        await validateToken(storedToken);
      }
    } catch (error) {
      console.error('Failed to load stored session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const validateToken = async (token: string) => {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        // Token is invalid, clear session
        await clearSession();
      }
    } catch (error) {
      console.error('Token validation failed:', error);
    }
  };

  const exchangeCodeForToken = async (
    code: string,
    codeVerifier: string,
    state: string
  ) => {
    try {
      setIsLoading(true);

      // Exchange code for token via our backend
      const res = await fetch(`${API_URL}/api/auth/mobile/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri, codeVerifier, state }),
      });

      if (!res.ok) {
        throw new Error('Token exchange failed');
      }

      const data = await res.json();
      const { accessToken: token, user: userData } = data;

      // Store in secure storage
      await SecureStore.setItemAsync(TOKEN_KEY, token);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(userData));

      setAccessToken(token);
      setUser(userData);
    } catch (error) {
      console.error('Token exchange error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const signIn = useCallback(async (): Promise<boolean> => {
    try {
      setIsLoading(true);
      const result = await promptAsync();
      return result?.type === 'success';
    } catch (error) {
      console.error('Sign in error:', error);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [promptAsync]);

  const clearSession = async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    setAccessToken(null);
    setUser(null);
  };

  const signOut = useCallback(async () => {
    try {
      setIsLoading(true);
      await clearSession();
    } catch (error) {
      console.error('Sign out error:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshSession = useCallback(async () => {
    if (accessToken) {
      await validateToken(accessToken);
    }
  }, [accessToken]);

  const value: AuthContextType = {
    user,
    accessToken,
    isAuthenticated: !!accessToken && !!user,
    isLoading,
    signIn,
    signOut,
    refreshSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
