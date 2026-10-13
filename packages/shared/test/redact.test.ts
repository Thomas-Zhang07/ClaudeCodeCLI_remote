import { describe, expect, it } from 'vitest';
import { redactDeep, redactText } from '../src/redact.js';

describe('redactText', () => {
  it('scrubs an Anthropic-style key', () => {
    const out = redactText('key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx here');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[redacted:anthropic-key]');
  });

  it('scrubs the bare sk- form used by OpenAI-compatible endpoints', () => {
    const out = redactText('ANTHROPIC_AUTH_TOKEN=sk-d761347f0f7c4869abd17a83ec81feec');
    expect(out).not.toContain('d761347f0f7c4869abd17a83ec81feec');
  });

  it('scrubs GitHub tokens', () => {
    expect(redactText('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toContain(
      '[redacted:github-token]',
    );
  });

  it('scrubs AWS access key ids', () => {
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toContain('[redacted:aws-access-key]');
  });

  it('scrubs an Authorization header while keeping the header name', () => {
    const out = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef');
    expect(out).toContain('Authorization:');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.abcdef');
  });

  it('scrubs values assigned to secret-looking names', () => {
    const out = redactText('GITEE_TOKEN=abcdef1234567890 and PASSWORD=hunter2hunter2');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).not.toContain('hunter2hunter2');
  });

  it('scrubs credentials embedded in a connection string', () => {
    const out = redactText('postgres://admin:s3cr3tpassword@db.example.com:5432/app');
    expect(out).not.toContain('s3cr3tpassword');
    expect(out).toContain('db.example.com');
  });

  it('scrubs a private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const out = redactText(pem);
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain('[redacted:private-key]');
  });

  it('leaves ordinary prose alone', () => {
    const text = 'I refactored the parser and added tests for the UTF-8 boundary case.';
    expect(redactText(text)).toBe(text);
  });

  it('leaves an ordinary file path alone', () => {
    const text = 'E:\\CCCLI_remote\\packages\\shared\\src\\parse.ts';
    expect(redactText(text)).toBe(text);
  });

  it('does not double-redact an existing marker', () => {
    const once = redactText('sk-ant-abcdefghijklmnopqrstuvwxyz');
    expect(redactText(once)).toBe(once);
  });

  it('is a no-op for very short strings', () => {
    expect(redactText('hi')).toBe('hi');
  });
});

describe('redactDeep', () => {
  it('walks nested objects and arrays', () => {
    const out = redactDeep({
      tool: 'Bash',
      input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x' },
      list: ['AKIAIOSFODNN7EXAMPLE', 'harmless'],
    });

    const s = JSON.stringify(out);
    expect(s).not.toContain('abcdefghijklmnop');
    expect(s).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(s).toContain('harmless');
  });

  it('passes through non-string leaves unchanged', () => {
    expect(redactDeep({ n: 42, b: true, z: null })).toEqual({ n: 42, b: true, z: null });
  });
});
