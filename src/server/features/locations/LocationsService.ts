import { LocationsRepository } from "./LocationsRepository";

// 90 days in milliseconds
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface DataForSeoLocation {
  location_code: number;
  location_name: string;
  location_name_parent: string | null;
  location_type: string;
  country_iso_code: string;
}

interface DataForSeoLocationsResponse {
  tasks?: Array<{
    result?: DataForSeoLocation[];
  }>;
}

function normalizeForSearch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function ensureCachePopulated(dataForSeoApiKey: string): Promise<void> {
  const rowCount = await LocationsRepository.getCount();

  if (rowCount > 0) {
    const oldestFetchedAt = await LocationsRepository.getOldestFetchedAt();
    if (oldestFetchedAt) {
      const ageMs = Date.now() - new Date(oldestFetchedAt).getTime();
      if (ageMs < CACHE_TTL_MS) {
        // Cache is fresh, nothing to do
        return;
      }
    }
    // Cache is stale — clear and re-fetch
    await LocationsRepository.clearAll();
  }

  // Fetch all locations from DataForSEO
  const response = await fetch(
    "https://api.dataforseo.com/v3/serp/google/locations",
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${dataForSeoApiKey}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `DataForSEO locations fetch failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as DataForSeoLocationsResponse;
  const rawLocations = data.tasks?.[0]?.result ?? [];

  const now = new Date().toISOString();

  const locations = rawLocations.map((loc) => ({
    code: loc.location_code,
    name: loc.location_name,
    fullName: loc.location_name_parent
      ? `${loc.location_name}, ${loc.location_name_parent}`
      : loc.location_name,
    nameNormalized: normalizeForSearch(
      loc.location_name_parent
        ? `${loc.location_name}, ${loc.location_name_parent}`
        : loc.location_name,
    ),
    type: loc.location_type,
    countryCode: loc.country_iso_code,
    fetchedAt: now,
  }));

  await LocationsRepository.insertBatch(locations);
}

async function search(
  query: string,
  limit = 20,
): Promise<ReturnType<typeof LocationsRepository.search>> {
  if (query.trim().length < 2) {
    return Promise.resolve([]);
  }
  const normalizedQuery = normalizeForSearch(query);
  return LocationsRepository.search(normalizedQuery, limit);
}

async function getByCode(code: number) {
  return LocationsRepository.getByCode(code);
}

export const LocationsService = {
  ensureCachePopulated,
  search,
  getByCode,
  normalizeForSearch,
};
