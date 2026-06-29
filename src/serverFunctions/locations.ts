import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { LocationsService } from "@/server/features/locations/LocationsService";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";

const searchLocationsSchema = z.object({
  query: z.string().min(2).max(100),
});

export const searchLocations = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .inputValidator((data: unknown) => searchLocationsSchema.parse(data))
  .handler(async ({ data }) => {
    const apiKey = await getRequiredEnvValue("DATAFORSEO_API_KEY");
    await LocationsService.ensureCachePopulated(apiKey);
    return LocationsService.search(data.query);
  });

export const populateLocationsCache = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => {
    const apiKey = await getRequiredEnvValue("DATAFORSEO_API_KEY");
    await LocationsService.ensureCachePopulated(apiKey);
    return { success: true };
  });
