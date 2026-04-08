import * as SecureStore from 'expo-secure-store';

const LOCAL_API_URL = 'http://localhost:3000';

function isSafeLocalFallback() {
  return typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';
}

function resolveApiUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    return configuredUrl;
  }

  if (isSafeLocalFallback()) {
    return LOCAL_API_URL;
  }

  throw new Error('EXPO_PUBLIC_API_URL must be set for production builds.');
}

export const API_URL = resolveApiUrl();
export const OAUTH_URL = process.env.EXPO_PUBLIC_OAUTH_URL?.trim() || API_URL;

const TOKEN_KEY = 'qagent_access_token';

interface FetchOptions extends RequestInit {
  authenticated?: boolean;
}

/**
 * API client for making requests to the QAgent backend
 */
export async function apiClient<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const { authenticated = true, ...fetchOptions } = options;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...fetchOptions.headers,
  };

  // Add authorization header if authenticated
  if (authenticated) {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }
  }

  const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;

  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || error.error || 'Request failed');
  }

  return response.json();
}

export async function setStoredToken(token: string | null) {
  if (token) {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
}

export async function getStoredToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

/**
 * Fetcher function for SWR
 */
export const swrFetcher = async <T>(url: string): Promise<T> => {
  return apiClient<T>(url);
};

/**
 * API methods for common operations
 */
export const api = {
  initialize: async () => {
    await getStoredToken();
  },
  setToken: async (token: string | null) => {
    await setStoredToken(token);
  },
  clearToken: async () => {
    await setStoredToken(null);
  },
  post: async <T>(endpoint: string, body: Record<string, unknown>, authenticated = true) =>
    apiClient<T>(endpoint, {
      method: 'POST',
      authenticated,
      body: JSON.stringify(body),
    }),
  // Runs
  getRuns: () => apiClient<{ runs: any[]; stats: any }>('/api/runs'),
  getRun: (id: string) => apiClient<{ run: any }>(`/api/runs/${id}`),
  createRun: (data: any) =>
    apiClient<{ run: any }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  cancelRun: (id: string) =>
    apiClient<{ success: boolean }>(`/api/runs/${id}`, {
      method: 'DELETE',
    }),

  // Session
  getSession: () =>
    apiClient<{ authenticated: boolean; user?: any; repos?: any[] }>('/api/auth/session'),

  // Patches
  getPatches: () => apiClient<{ patches: any[] }>('/api/patches'),
  getPatch: (id: string) => apiClient<{ patch: any }>(`/api/patches/${id}`),

  // Tests
  getTests: () => apiClient<{ testSpecs: any[] }>('/api/tests'),

  // Notifications
  registerPushToken: (token: string, platform: string) =>
    apiClient<{ success: boolean }>('/api/notifications/register', {
      method: 'POST',
      body: JSON.stringify({ token, platform }),
    }),
};
