interface Config {
  apiEndpoint: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
}

let config: Config | null = null;

export async function getConfig(): Promise<Config> {
  if (config) return config;

  // In development, use environment variables or defaults
  if (import.meta.env.DEV) {
    config = {
      apiEndpoint: import.meta.env.VITE_API_ENDPOINT || 'http://localhost:3001',
      userPoolId: import.meta.env.VITE_USER_POOL_ID || '',
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID || '',
      region: import.meta.env.VITE_REGION || 'eu-central-1',
    };
    return config;
  }

  // In production, fetch from config.json deployed alongside the app
  try {
    const response = await fetch('/config.json');
    config = await response.json();
    return config!;
  } catch (error) {
    console.error('Failed to load config:', error);
    throw new Error('Failed to load application configuration');
  }
}
