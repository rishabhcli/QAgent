/**
 * Daytona Client
 *
 * Lazy singleton for the Daytona SDK.
 * Build-time safe — won't initialize until first use.
 */

import { Daytona } from '@daytonaio/sdk';

let client: Daytona | null = null;

export function getDaytonaClient(): Daytona {
  if (!client) {
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error('DAYTONA_API_KEY is not configured');
    }
    client = new Daytona({
      apiKey,
      apiUrl: process.env.DAYTONA_API_URL || 'https://app.daytona.io/api',
    });
  }
  return client;
}

export function isDaytonaConfigured(): boolean {
  return Boolean(process.env.DAYTONA_API_KEY);
}
