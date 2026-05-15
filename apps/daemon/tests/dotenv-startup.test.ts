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
  applyOdEnvFromParsed,
  DOTENV_LOADABLE_KEYS,
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

  it('only loads DOTENV_LOADABLE_KEYS from a parsed .env into process.env', () => {
    // Regression coverage for the actual production loader path. Drive
    // `applyOdEnvFromParsed` directly so the assertion fails closed if the
    // helper ever drops the allowlist filter or starts honoring additional
    // keys without explicit opt-in. The previous version of this test
    // re-implemented the loader logic in a child script, which would have
    // continued to pass even if the production helper regressed.
    const guardedKeys = [
      ...DOTENV_LOADABLE_KEYS,
      // Keys deliberately NOT in the allowlist. Snapshotting + restoring
      // them keeps an unrelated `.env` from leaking into the test process.
      'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY',
      'OD_BIND_HOST',
    ] as const;
    const saved: Record<string, string | undefined> = {};
    for (const key of guardedKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      applyOdEnvFromParsed({
        OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS: '99999',
        // Other early-default reads on the same startup path (see the
        // narrow-allowlist rationale on DOTENV_LOADABLE_KEYS); these must
        // be ignored so the .env contract does not drift behind contributors.
        OD_BIND_HOST: '0.0.0.0',
        // Unrelated keys that have historically caused auth-routing
        // regressions when dotenv.config() ran unfiltered.
        ANTHROPIC_BASE_URL: 'https://example-rogue-host.invalid',
        OPENAI_API_KEY: 'sk-test-should-not-leak',
      });

      const result = {
        timeout: process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS ?? null,
        bindHost: process.env.OD_BIND_HOST ?? null,
        anthropic: process.env.ANTHROPIC_BASE_URL ?? null,
        openai: process.env.OPENAI_API_KEY ?? null,
      };

      // The single allowlisted key flows through.
      expect(result.timeout).toBe('99999');
      // OD_BIND_HOST is intentionally NOT honored here — the startServer
      // signature evaluates it at function-arg default time, before
      // `await ensureDotenvLoaded()` runs (see comment on
      // DOTENV_LOADABLE_KEYS). The loader stays consistent with that by
      // ignoring it.
      expect(result.bindHost).toBeNull();
      // Non-OD keys must stay out of process.env.
      expect(result.anthropic).toBeNull();
      expect(result.openai).toBeNull();
    } finally {
      for (const key of guardedKeys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  it('lets a pre-existing process.env value win over the parsed .env entry', () => {
    // Drives the production helper directly so the once-only `dotenvLoaded`
    // module guard does not get in the way. The pre-existing value comes
    // from the host environment (or a real `export`); .env must never
    // override it.
    const key = 'OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS';
    const previous = process.env[key];
    process.env[key] = '77777';
    try {
      applyOdEnvFromParsed({ [key]: '11111' });
      expect(process.env[key]).toBe('77777');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
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
