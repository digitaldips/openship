/**
 * Openship Cloud (Oblien) resource tiers.
 *
 * The dashboard's `CLOUD_RESOURCE_TIERS` picker (DeployTargetStep.tsx) shows
 * matching labels; the numbers below are the concrete cpu/memory/disk they map
 * to. The resolved ResourceConfig rides `snapshot.resources` → `prodResources`
 * → the runtime's deploy config — see `requestBuildAccess`. Keep the two lists
 * in sync.
 *
 * Only consulted for a SERVER-BACKED cloud deploy. Static (Pages) deploys have
 * no workspace to size, and non-cloud targets keep the project's own resource
 * config.
 *
 * NOTE (current runtime coverage — plumbed, not yet fully enforced):
 *   - compose cloud: cpu/memory ARE applied (createImageServiceWorkspace);
 *     disk is currently hardcoded to the default (cloud/runtime/cloud/compose.ts).
 *   - single-app cloud: the deploy reuses the build workspace and the prod
 *     cpu/memory resize is intentionally disabled (cloud.ts `deploy()` TODO,
 *     "testing without resource shrink"), so the tier does NOT yet resize a
 *     single-app workspace. Re-enable that resize to make this fully effective.
 */

import type { ResourceConfig } from "@repo/adapters";

export type CloudResourceTier = "micro" | "low" | "medium" | "high" | "custom";

/** User-supplied values when tier === "custom". Same shape as ResourceConfig. */
export interface CloudResourceCustom {
  cpuCores: number;
  memoryMb: number;
  diskMb: number;
}

const TIER_RESOURCES: Record<Exclude<CloudResourceTier, "custom">, ResourceConfig> = {
  micro: { cpuCores: 0.25, memoryMb: 256, diskMb: 4096 },
  low: { cpuCores: 0.5, memoryMb: 512, diskMb: 8192 },
  medium: { cpuCores: 1, memoryMb: 1024, diskMb: 16384 },
  high: { cpuCores: 2, memoryMb: 2048, diskMb: 32768 },
};

/**
 * Resolve a cloud resource tier (or custom values) into the concrete
 * ResourceConfig the cloud runtime provisions with. A "custom" selection
 * with missing/invalid values falls back to the "low" tier.
 */
export function resolveCloudResourceConfig(
  tier: CloudResourceTier,
  custom?: CloudResourceCustom | null,
): ResourceConfig {
  if (tier === "custom") {
    if (custom && custom.cpuCores > 0 && custom.memoryMb > 0 && custom.diskMb > 0) {
      return {
        cpuCores: custom.cpuCores,
        memoryMb: custom.memoryMb,
        diskMb: custom.diskMb,
      };
    }
    return TIER_RESOURCES.low;
  }
  return TIER_RESOURCES[tier];
}
