import type { ProviderName } from "./config";

export type PrivacyMode = "local-only" | "remote-provider-explicit";

export type ProviderPrivacy = {
  provider: ProviderName;
  remote: boolean;
  mode: PrivacyMode;
  explicitRemoteUse: boolean;
  promptPersistence: "local-redacted-artifact";
  responsePersistence: "local-redacted-artifact";
  egress: "none" | "provider-api";
};

export function providerPrivacy(provider: ProviderName): ProviderPrivacy {
  const remote = provider !== "local";
  return {
    provider,
    remote,
    mode: remote ? "remote-provider-explicit" : "local-only",
    explicitRemoteUse: remote,
    promptPersistence: "local-redacted-artifact",
    responsePersistence: "local-redacted-artifact",
    egress: remote ? "provider-api" : "none"
  };
}

export function isRemoteProvider(provider: ProviderName | string | undefined): boolean {
  return Boolean(provider && provider !== "local");
}
