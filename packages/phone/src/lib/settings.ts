/**
 * User configuration, persisted to localStorage.
 *
 * The token and the shared secret are the two secrets in the app: the token can
 * write to the relay repository, and the secret authenticates the prompts that
 * repository carries. Both live only in this browser.
 */

import { computed, reactive } from 'vue';

import { getJSON, setJSON } from './storage';

export interface Settings {
  owner: string;
  repo: string;
  /** Gitee personal access token, scoped to the relay repository. */
  token: string;
  /** Shared with the PC as CCR_SECRET; keys the prompt HMAC. */
  secret: string;
  /**
   * How often to poll the head of a session that is actively working.
   *
   * The session list and any session that is not working use a fixed slow
   * cadence, because the bridge publishes on turn boundaries rather than
   * continuously and a faster poll mostly returns `304`s — which Gitee charges
   * quota for anyway.
   */
  pollMs: number;
}

export const POLL_MIN_MS = 10_000;
export const POLL_MAX_MS = 60_000;

const KEY = 'ccr.settings.v1';

/**
 * Build-time defaults for the fields that are not secret.
 *
 * Owner, repository and cadence are not credentials, so pre-filling them from
 * the repository's `.env` saves typing without exposing anything.
 *
 * The token and the secret are deliberately **not** given defaults and must
 * never be added here. They are served from a public URL, so anything baked into
 * this bundle is readable by anyone who opens the page — and the token reads
 * every relayed session and can write prompts into the PC.
 */
const BUILD_DEFAULTS = {
  owner: import.meta.env.VITE_CCR_OWNER ?? '',
  repo: import.meta.env.VITE_CCR_REPO ?? '',
  pollMs: Number.parseInt(import.meta.env.VITE_CCR_POLL_MS ?? '', 10),
} as const;

const DEFAULTS: Settings = {
  owner: BUILD_DEFAULTS.owner,
  repo: BUILD_DEFAULTS.repo,
  token: '',
  secret: '',
  pollMs: Number.isFinite(BUILD_DEFAULTS.pollMs) ? BUILD_DEFAULTS.pollMs : 15_000,
};

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function clampPoll(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULTS.pollMs;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(ms)));
}

function load(): Settings {
  const raw = getJSON<Partial<Settings>>(KEY, {});
  return {
    // An empty stored value falls back to the build default rather than
    // winning. Anyone who opened Settings before the defaults existed has `''`
    // saved, and treating that as a deliberate choice would silently defeat the
    // pre-fill for exactly the people it was added for. These two fields are
    // never meaningfully empty — the app cannot work without them.
    owner: nonEmpty(raw.owner) ?? DEFAULTS.owner,
    repo: nonEmpty(raw.repo) ?? DEFAULTS.repo,
    token: typeof raw.token === 'string' ? raw.token : '',
    secret: typeof raw.secret === 'string' ? raw.secret : '',
    pollMs: clampPoll(typeof raw.pollMs === 'number' ? raw.pollMs : DEFAULTS.pollMs),
  };
}

export const settings = reactive<Settings>(load());

/**
 * Returns false when the settings could not be written (private mode, quota,
 * storage disabled). The in-memory values still apply for this session.
 */
export function saveSettings(patch: Partial<Settings>): boolean {
  if (patch.owner !== undefined) settings.owner = patch.owner.trim();
  if (patch.repo !== undefined) settings.repo = patch.repo.trim();
  if (patch.token !== undefined) settings.token = patch.token.trim();
  if (patch.secret !== undefined) settings.secret = patch.secret.trim();
  if (patch.pollMs !== undefined) settings.pollMs = clampPoll(patch.pollMs);
  return setJSON(KEY, { ...settings });
}

export function clearSettings(): void {
  saveSettings({ owner: '', repo: '', token: '', secret: '' });
}

export const isConfigured = computed(
  () => settings.owner !== '' && settings.repo !== '' && settings.token !== '',
);

export const canSign = computed(() => settings.secret !== '');
