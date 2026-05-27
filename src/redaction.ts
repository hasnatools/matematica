const SECRET_ENV_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|authorization|auth[_-]?key)/i;
const SECRET_JSON_KEY_PATTERN = /^(api[_-]?key|auth[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret|password|credential|authorization|bearer)$/i;
const SECRET_JSON_CAMEL_KEY_PATTERN = /^(apiKey|authKey|accessToken|refreshToken|idToken|clientSecret|privateKey)$/;
const MIN_SECRET_LENGTH = 8;
const BUILTIN_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g,
  /\b(https?:\/\/[^:\s/@]+:)[^@\s/]+@/g,
  /([?&](?:api[_-]?key|access[_-]?token|token|secret|password|credential|authorization)=)[^&\s"'<>]+/gi
];

export function redactText(input: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = input;
  for (const secret of collectSecretValues(env)) {
    output = output.split(secret).join("<redacted>");
  }
  for (const pattern of BUILTIN_SECRET_PATTERNS) {
    output = output.replace(pattern, "<redacted>");
  }
  return output;
}

export function redactJson<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") return redactText(value, env) as T;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, env)) as T;
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSensitiveJsonKey(key) && item !== undefined && item !== null
      ? "<redacted>"
      : redactJson(item, env);
  }
  return redacted as T;
}

export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_ENV_KEY_PATTERN.test(key)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function isSensitiveJsonKey(key: string): boolean {
  return SECRET_JSON_KEY_PATTERN.test(key) || SECRET_JSON_CAMEL_KEY_PATTERN.test(key);
}
