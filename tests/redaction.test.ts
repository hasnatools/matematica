import { expect, test } from "bun:test";
import { redactJson, redactText } from "../src/redaction";

test("redactJson redacts sensitive key values even when value shape is not recognized", () => {
  const payload = {
    apiKey: "plain-value-that-does-not-match-builtins",
    nested: {
      clientSecret: "another-plain-secret",
      authorization: "custom authorization value"
    },
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12
    },
    safe: "visible"
  };

  expect(redactJson(payload)).toEqual({
    apiKey: "<redacted>",
    nested: {
      clientSecret: "<redacted>",
      authorization: "<redacted>"
    },
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12
    },
    safe: "visible"
  });
});

test("redactText redacts URLs bearer tokens and configured secret env values", () => {
  const redacted = redactText(
    "Bearer token-value-123456 https://user:password-value-123456@example.test/path?api_key=query-secret-123456 env-secret-123456",
    { TEST_API_KEY: "env-secret-123456" }
  );

  expect(redacted).toContain("<redacted>");
  expect(redacted).not.toContain("token-value-123456");
  expect(redacted).not.toContain("password-value-123456");
  expect(redacted).not.toContain("query-secret-123456");
  expect(redacted).not.toContain("env-secret-123456");
});
