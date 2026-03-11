import { InfrastructureServiceClient } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';

const client = new InfrastructureServiceClient('', { fetch: (input, init) => globalThis.fetch(input, init) });

export type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

export interface PreciseCoordinates {
  lat: number;
  lon: number;
}

const VIEW_COUNTRIES: Record<Exclude<MapView, 'global'>, string[]> = {
  america: ['US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'VE'],
  mena: ['IL', 'PS', 'LB', 'SY', 'JO', 'EG', 'SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'YE', 'IQ', 'IR', 'TR'],
  eu: ['GB', 'FR', 'DE', 'IT', 'ES', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'FI', 'DK', 'PL', 'CZ', 'HU', 'GR', 'PT', 'IE', 'UA', 'RU'],
  asia: ['CN', 'JP', 'KR', 'IN', 'ID', 'MY', 'SG', 'TH', 'VN', 'PH', 'PK', 'BD', 'TW'],
  latam: ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'VE', 'CU', 'PR', 'UY', 'PY', 'BO', 'EC'],
  africa: ['ZA', 'NG', 'EG', 'KE', 'ET', 'DZ', 'MA', 'GH', 'CI', 'TZ', 'UG', 'SD'],
  oceania: ['AU', 'NZ', 'FJ', 'PG', 'SB', 'VU'],
};

let locationCache: { country: string; timestamp: number } | null = null;
const CACHE_TTL = 1 * 60 * 60 * 1000; // 1 hour

export async function fetchUserLocation(): Promise<string> {
  const now = Date.now();
  if (locationCache && now - locationCache.timestamp < CACHE_TTL) {
    return locationCache.country;
  }

  try {
    const response = await client.getIpGeo({});
    const country = response.country || 'XX';
    locationCache = { country, timestamp: now };
    return country;
  } catch (err) {
    console.warn('[UserLocation] Failed to fetch IP geo:', err);
    return 'XX';
  }
}

let _countryPromise: Promise<string | null> | undefined;

async function resolveCountryCodeInternal(): Promise<string | null> {
  try {
    const response = await client.getIpGeo({}, { signal: AbortSignal.timeout(3000) });
    const country = response.country || 'XX';
    if (country !== 'XX') return country;
  } catch { /* fallback to timezone */ }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz.includes('Jerusalem') || tz.includes('Tel_Aviv')) return 'IL';
    if (tz.includes('London')) return 'GB';
    if (tz.includes('New_York') || tz.includes('Los_Angeles') || tz.includes('Chicago')) return 'US';
    if (tz.includes('Sao_Paulo')) return 'BR';
    if (tz.includes('Paris') || tz.includes('Berlin') || tz.includes('Rome')) return 'EU';
  } catch { /* skip */ }

  return null;
}

export function resolveCountryCode(): Promise<string | null> {
  if (_countryPromise) return _countryPromise;
  _countryPromise = resolveCountryCodeInternal();
  return _countryPromise;
}

export async function getDefaultViewForUser(): Promise<MapView> {
  const country = await fetchUserLocation();
  if (country === 'XX') return 'global';

  for (const [view, countries] of Object.entries(VIEW_COUNTRIES)) {
    if (countries.includes(country)) return view as MapView;
  }

  return 'global';
}

export async function resolveUserRegion(): Promise<MapView> {
  return getDefaultViewForUser();
}

export async function resolvePreciseUserCoordinates(timeoutMs = 5000): Promise<PreciseCoordinates | null> {
  if (!navigator.geolocation) return null;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timeout);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        clearTimeout(timeout);
        resolve(null);
      },
      { timeout: timeoutMs }
    );
  });
}
