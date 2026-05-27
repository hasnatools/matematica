import type { MatematicaConfig } from "./config";

export type NetworkMode = "online" | "offline";

export type NetworkPolicy = {
  mode: NetworkMode;
  offline: boolean;
  localOnly: boolean;
  reason?: string;
};

export function networkPolicy(input: {
  config: MatematicaConfig;
  offlineRequested?: boolean;
  networkRequested?: boolean;
}): NetworkPolicy {
  if (input.offlineRequested === true && input.networkRequested === true) {
    throw new Error("Choose either --offline or --allow-network, not both.");
  }
  const offline = input.offlineRequested === true || input.config.localOnly || input.networkRequested !== true;
  return {
    mode: offline ? "offline" : "online",
    offline,
    localOnly: input.config.localOnly,
    reason: input.offlineRequested === true
      ? "offline flag requested"
      : input.config.localOnly
        ? "MATEMATICA_LOCAL_ONLY=true"
        : offline
          ? "zero-network default"
          : "explicit network flag requested"
  };
}
