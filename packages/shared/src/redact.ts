/**
 * Secret scrubbing.
 *
 * Anything the bridge publishes lands on a third party's disk (Gitee), so every
 * outbound string passes through here first. Transcripts routinely contain API
 * keys in shell commands, environment dumps, and file reads.
 *
 * This is a safety net, not a guarantee. It catches well-known credential shapes
 * and obvious assignments; it cannot catch a secret that looks like prose.
 */

interface Rule {
  name: string;
  pattern: RegExp;
}

/**
 * Order matters only in that earlier rules win on overlapping matches. Each
 * pattern is applied globally to the whole string.
 */
const RULES: Rule[] = [
  // Provider-prefixed keys. Anthropic and OpenAI-compatible providers (including
  // the DeepSeek endpoint this project was developed against) both use sk-.
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}/g },
  // Gitee personal access tokens are opaque hex; only redact when labelled.
  { name: 'gitee-token', pattern: /\b[0-9a-f]{32,64}\b(?=[^\n]{0,40}\bgitee)/gi },
  // Git hosting tokens.
  { name: 'github-token', pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  // Cloud credentials.
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'aws-secret', pattern: /(?<=\baws_secret_access_key\s*[=:]\s*)\S+/gi },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  // JSON Web Tokens.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Private key blocks.
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // Authorization headers and bearer tokens.
  { name: 'auth-header', pattern: /(?<=\bAuthorization\s*:\s*)(?:Bearer|Basic|token)\s+\S+/gi },
  { name: 'bearer', pattern: /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi },
  // Labelled assignments in shell, .env, and config forms.
  {
    name: 'assigned-secret',
    pattern:
      /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"',;]{8,}/gi,
  },
  // Connection strings with embedded credentials.
  {
    name: 'connection-string',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  },
];

/** Matches what is already a redaction marker, so we never double-process. */
const ALREADY_REDACTED = /^\[redacted:/;

/**
 * Replace anything that looks like a credential.
 *
 * The replacement is a fixed-width marker rather than a fixed number of `*`, so
 * the original length is not leaked.
 */
export function redactText(input: string): string {
  if (!input || input.length < 8) return input;

  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) => {
      if (ALREADY_REDACTED.test(match)) return match;
      return `[redacted:${rule.name}]`;
    });
  }
  return out;
}

/**
 * Redact a value that may be a nested JSON structure.
 *
 * Used for the fields we copy through wholesale (tool inputs, patches). Cycles
 * are not expected in transcript data, but depth is bounded anyway.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 24) return value;

  if (typeof value === 'string') return redactText(value) as unknown as T;

  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out as unknown as T;
  }

  return value;
}

/** Exposed for tests. */
export const REDACTION_RULES: readonly string[] = RULES.map((r) => r.name);
