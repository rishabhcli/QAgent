const DEV_SESSION_SECRET_GLOBAL_KEY = '__PATCHPILOT_DEV_SESSION_SECRET__';

type GlobalWithSecret = typeof globalThis & {
  [DEV_SESSION_SECRET_GLOBAL_KEY]?: string;
};

function getDevSessionSecret(): string {
  const globalWithSecret = globalThis as GlobalWithSecret;
  if (!globalWithSecret[DEV_SESSION_SECRET_GLOBAL_KEY]) {
    globalWithSecret[DEV_SESSION_SECRET_GLOBAL_KEY] = crypto.randomUUID();
  }

  return globalWithSecret[DEV_SESSION_SECRET_GLOBAL_KEY];
}

export function getSessionSecret(): string {
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret) {
    return envSecret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET environment variable is required in production');
  }

  return getDevSessionSecret();
}
