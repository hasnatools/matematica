import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Artifact } from "./domain";

export const STORAGE_ENCRYPTION_FORMAT = "matematica.storage-encryption.v1";
const ENCRYPTED_PREFIX = "matematica.enc.v1:";
const DEFAULT_KEY_ENV = "MATEMATICA_STORAGE_KEY";

export type StorageEncryptionConfig = {
  enabled: boolean;
  keyEnv: string;
};

export type StorageEncryptionEnvelope = {
  format: typeof STORAGE_ENCRYPTION_FORMAT;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  aad: string;
  keyCheck: string;
};

export function initializeEncryptedHome(root: string, options: { keyEnv?: string } = {}): StorageEncryptionConfig {
  const configPath = join(root, "config.json");
  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
    : {};
  const storageEncryption = {
    enabled: true,
    keyEnv: options.keyEnv ?? DEFAULT_KEY_ENV,
    format: STORAGE_ENCRYPTION_FORMAT,
    keyPersistence: "external-env-only"
  };
  writeFileSync(configPath, `${JSON.stringify({ ...existing, storageEncryption }, null, 2)}\n`, { mode: 0o600 });
  return { enabled: true, keyEnv: storageEncryption.keyEnv };
}

export function storageEncryptionConfigForPath(path: string): StorageEncryptionConfig {
  const root = path.endsWith("/artifacts") ? dirname(path) : dirname(path);
  return storageEncryptionConfigForRoot(root);
}

export function storageEncryptionConfigForArtifactRoot(artifactsDir: string): StorageEncryptionConfig {
  return storageEncryptionConfigForRoot(dirname(artifactsDir));
}

export function storageEncryptionConfigForRoot(root: string): StorageEncryptionConfig {
  const envEnabled = booleanFrom(process.env.MATEMATICA_STORAGE_ENCRYPTION);
  const configPath = join(root, "config.json");
  const fileConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
    : {};
  const storage = recordValue(fileConfig.storageEncryption);
  const enabled = envEnabled ?? booleanFrom(storage.enabled) ?? false;
  const keyEnv = stringValue(process.env.MATEMATICA_STORAGE_KEY_ENV) ?? stringValue(storage.keyEnv) ?? DEFAULT_KEY_ENV;
  return { enabled, keyEnv };
}

export function encryptStringForStorage(root: string, plaintext: string, aad: string): string {
  const config = storageEncryptionConfigForRoot(root);
  if (!config.enabled) return plaintext;
  return `${ENCRYPTED_PREFIX}${Buffer.from(JSON.stringify(encryptBytes(Buffer.from(plaintext, "utf8"), config, aad)), "utf8").toString("base64")}`;
}

export function decryptStringFromStorage(root: string, value: string, aad: string): string {
  if (!isEncryptedStorageString(value)) return value;
  const config = storageEncryptionConfigForRoot(root);
  if (!config.enabled) throw new Error("Storage is encrypted but encryption is not enabled for this process.");
  return decryptBytes(encryptedEnvelopeFromString(value), config, aad).toString("utf8");
}

export function isEncryptedStorageString(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptArtifactContent(root: string, artifact: Pick<Artifact, "runId" | "kind" | "sha256">, plaintext: string): { content: string; encrypted: boolean } {
  const config = storageEncryptionConfigForRoot(root);
  if (!config.enabled) return { content: plaintext, encrypted: false };
  const envelope = encryptBytes(Buffer.from(plaintext, "utf8"), config, artifactAad(artifact));
  return {
    content: JSON.stringify(envelope, null, 2),
    encrypted: true
  };
}

export function readArtifactBytes(artifact: Artifact): Buffer {
  const bytes = readFileSync(artifact.path);
  const encryption = recordValue(artifact.provenance?.storageEncryption);
  if (encryption.enabled !== true) return bytes;
  const root = dirname(dirname(dirname(artifact.path)));
  const config = storageEncryptionConfigForRoot(root);
  const parsed = JSON.parse(bytes.toString("utf8")) as StorageEncryptionEnvelope;
  return decryptBytes(parsed, config, artifactAad(artifact));
}

export function readArtifactText(artifact: Artifact): string {
  return readArtifactBytes(artifact).toString("utf8");
}

function encryptBytes(plaintext: Buffer, config: StorageEncryptionConfig, aad: string): StorageEncryptionEnvelope {
  const passphrase = requiredKey(config);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const keyCheck = createKeyCheck(key, salt);
  return {
    format: STORAGE_ENCRYPTION_FORMAT,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    aad,
    keyCheck
  };
}

function decryptBytes(envelope: StorageEncryptionEnvelope, config: StorageEncryptionConfig, aad: string): Buffer {
  if (envelope.format !== STORAGE_ENCRYPTION_FORMAT || envelope.algorithm !== "aes-256-gcm" || envelope.kdf !== "scrypt") {
    throw new Error("Unsupported encrypted storage envelope.");
  }
  if (envelope.aad !== aad) throw new Error("Encrypted storage envelope AAD mismatch.");
  const salt = Buffer.from(envelope.salt, "base64");
  const key = scryptSync(requiredKey(config), salt, 32);
  const expectedKeyCheck = Buffer.from(createKeyCheck(key, salt), "utf8");
  const actualKeyCheck = Buffer.from(envelope.keyCheck, "utf8");
  if (expectedKeyCheck.length !== actualKeyCheck.length || !timingSafeEqual(expectedKeyCheck, actualKeyCheck)) {
    throw new Error("Encrypted storage key check failed.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
}

function encryptedEnvelopeFromString(value: string): StorageEncryptionEnvelope {
  return JSON.parse(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64").toString("utf8")) as StorageEncryptionEnvelope;
}

function requiredKey(config: StorageEncryptionConfig): string {
  const key = process.env[config.keyEnv];
  if (!key) throw new Error(`Encrypted storage requires ${config.keyEnv}; keys are not persisted in MATEMATICA_HOME.`);
  return key;
}

function createKeyCheck(key: Buffer, salt: Buffer): string {
  return createCipherlessDigest(`${key.toString("base64")}:${salt.toString("base64")}`).slice(0, 32);
}

function createCipherlessDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactAad(artifact: Pick<Artifact, "runId" | "kind" | "sha256">): string {
  return `${artifact.runId}:${artifact.kind}:${artifact.sha256}`;
}

function booleanFrom(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
