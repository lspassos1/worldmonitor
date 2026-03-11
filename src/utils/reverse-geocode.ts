import { InfrastructureServiceClient } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';

const client = new InfrastructureServiceClient('', { fetch: (input, init) => globalThis.fetch(input, init) });

/**
 * Result of a reverse geocoding operation.
 */
export interface GeoResult {
  country: string | null;
  code: string | null;
  displayName: string;
}

const cache = new Map<string, GeoResult | null>();
const TIMEOUT_MS = 10000;

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

/**
 * reverseGeocode takes a lat/lon and returns a human-readable country and code.
 * Results are cached in-memory and by the server-side proxy.
 */
export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<GeoResult | null> {
  const key = cacheKey(lat, lon);
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const response = await client.reverseGeocode({ lat, lon }, { signal: signal || AbortSignal.timeout(TIMEOUT_MS) });
    
    if (response.error) {
      console.warn(`[ReverseGeocode] Server error: ${response.error}`);
      cache.set(key, null);
      return null;
    }

    const result: GeoResult = {
      country: response.country || null,
      code: response.code || null,
      displayName: response.displayName || response.country || '',
    };
    
    cache.set(key, result);
    return result;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    console.warn(`[ReverseGeocode] Failed for ${lat},${lon}:`, err);
    cache.set(key, null);
    return null;
  }
}
