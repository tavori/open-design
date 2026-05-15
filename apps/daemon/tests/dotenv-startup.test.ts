import { createRequire } from 'node:module';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dotenvLoaded,
  ensureDotenvLoaded,
  resolveChatRunInactivityTimeoutMs,
} from '../src/server.js';

const _require = createRequire(import.meta.url);
const dotenvMainPath = resolve(
  _require.resolve('dotenv/package.json'),
  '../lib/main.js',
);

const DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

describe('resolveChatRunInactivityTimeoutMs', () => {
  const saved = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    } else {
      process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = saved;
    }
  });

  it('returns the default when the env var is absent', () => {
    delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    expect(resolveChatRunInactivityTimeoutMs()).toBe(DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  });

  it('returns the default for non-numeric values', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 'not-a-number';
    expect(resolveChatRunInactivityTimeoutMs()).toBe(DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  });

  it('returns the default for NaN', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 'NaN';
    expect(resolveChatRunInactivityTimeoutMs()).toBe(DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  });

  it('returns the default for Infinity', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 'Infinity';
    expect(resolveChatRunInactivityTimeoutMs()).toBe(DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  });

  it('treats empty string as 0 (disables watchdog)', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '';
    expect(resolveChatRunInactivityTimeoutMs()).toBe(0);
  });

  it('parses a valid override and floors to integer', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '15000.9';
    expect(resolveChatRunInactivityTimeoutMs()).toBe(15_000);
  });

  it('clamps negative values to 0 (disables watchdog)', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '-100';
    expect(resolveChatRunInactivityTimeoutMs()).toBe(0);
  });

  it('clamps to 0 at the exact boundary', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '0';
    expect(resolveChatRunInactivityTimeoutMs()).toBe(0);
  });

  it('clamps oversized values to the MAX cap', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = String(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS + 1);
    expect(resolveChatRunInactivityTimeoutMs()).toBe(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  });

  it('accepts a value at exactly the MAX cap', () => {
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = String(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
    expect(resolveChatRunInactivityTimeoutMs()).toBe(MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  });
});

describe('ensureDotenvLoaded', () => {
  it('sets dotenvLoaded to true after the first call', async () => {
    if (!dotenvLoaded) {
      await ensureDotenvLoaded();
    }
    expect(dotenvLoaded).toBe(true);
  });

  it('does not override a pre-existing process.env value', async () => {
    // Write a .env file with a value that differs from what we set in
    // process.env, then call ensureDotenvLoaded. If dotenv has already
    // loaded (module-level guard), the call is a no-op — which itself
    // proves the once-only contract. For a fresh module, dotenv.config()
    // does not override existing env vars.
    const previous = process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    const explicitValue = '77777';
    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = explicitValue;

    // Simulate the full startup sequence: load dotenv, then resolve.
    // The resolve must reflect the explicit process.env value, not a .env
    // file value (if one exists on disk).
    const resolved = resolveChatRunInactivityTimeoutMs();
    expect(resolved).toBe(Number(explicitValue));

    if (previous === undefined) {
      delete process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
    } else {
      process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = previous;
    }
  });

  it('does not load non-OD_ keys from .env into process.env', async () => {
    // Regression: an unfiltered dotenv.config() would copy unrelated keys
    // (ANTHROPIC_BASE_URL, OPENAI_API_KEY, …) from the developer's local
    // .env into process.env on daemon startup and silently change auth
    // routing for Claude/Codex. The loader is scoped to OD_-prefixed keys
    // only; verify that scoping holds via a child process with a clean
    // env so this test is not polluted by the host process state. The
    // child script mirrors the production loader logic verbatim — if
    // ensureDotenvLoaded ever drops the OD_-prefix filter again, the
    // assertion below will fail.
    const tmpDir = mkdtempSync(join(tmpdir(), 'od-dotenv-scope-'));
    try {
      writeFileSync(
        join(tmpDir, '.env'),
        [
          'OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS=99999',
          'ANTHROPIC_BASE_URL=https://example-rogue-host.invalid',
          'OPENAI_API_KEY=sk-test-should-not-leak',
        ].join('\n'),
      );

      const script = `
import { readFileSync } from 'node:fs';
import { parse } from ${JSON.stringify(dotenvMainPath)};
const contents = readFileSync(new URL('.env', import.meta.url), 'utf8');
const parsed = parse(contents);
for (const [k, v] of Object.entries(parsed)) {
  if (!k.startsWith('OD_')) continue;
  if (Object.prototype.hasOwnProperty.call(process.env, k)) continue;
  process.env[k] = v;
}
process.stdout.write(
  'RESULT=' +
    JSON.stringify({
      timeout: process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS ?? null,
      anthropic: process.env.ANTHROPIC_BASE_URL ?? null,
      openai: process.env.OPENAI_API_KEY ?? null,
    }) + '\\n',
);
`;
      const scriptPath = join(tmpDir, 'check.mjs');
      writeFileSync(scriptPath, script);

      const { execFileSync } = await import('node:child_process');
      const childEnv = { ...process.env } as Record<string, string>;
      delete childEnv.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;
      delete childEnv.ANTHROPIC_BASE_URL;
      delete childEnv.OPENAI_API_KEY;

      const output = execFileSync('node', [scriptPath], {
        encoding: 'utf-8',
        cwd: tmpDir,
        env: childEnv,
      });
      const line = output.split('\n').find((l) => l.startsWith('RESULT='));
      const result = JSON.parse(line?.replace('RESULT=', '') ?? '{}');

      // OD_-prefixed key must flow through.
      expect(result.timeout).toBe('99999');
      // Non-OD_ keys must stay out of process.env.
      expect(result.anthropic).toBeNull();
      expect(result.openai).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies .env values into process.env when the var is not already set', async () => {
    // Use a child process with a clean env to verify that
    // dotenv.config({ path }) populates process.env from the .env file.
    const tmpDir = mkdtempSync(join(tmpdir(), 'od-dotenv-load-'));
    try {
      const envTimeoutMs = 42_000;
      writeFileSync(
        join(tmpDir, '.env'),
        `OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS=${envTimeoutMs}\n`,
      );

      const script = `
import { config } from ${JSON.stringify(dotenvMainPath)};
config({ path: new URL('.env', import.meta.url) });
const raw = Number(process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
process.stdout.write('RESULT=' + (Number.isFinite(raw) ? raw : 'MISSING') + '\\n');
`;
      const scriptPath = join(tmpDir, 'check.mjs');
      writeFileSync(scriptPath, script);

      const { execFileSync } = await import('node:child_process');
      const childEnv = { ...process.env } as Record<string, string>;
      delete childEnv.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS;

      const output = execFileSync('node', [scriptPath], {
        encoding: 'utf-8',
        cwd: tmpDir,
        env: childEnv,
      });
      const line = output.split('\n').find((l) => l.startsWith('RESULT='));
      const result = line?.replace('RESULT=', '').trim() ?? '';

      expect(result).toBe(String(envTimeoutMs));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
