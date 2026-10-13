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
  /** Poll interval in ms. */
  pollMs: number;
}

export const POLL_MIN_MS = 5_000;
export const POLL_MAX_MS = 120_000;

const KEY = 'ccr.settings.v1';

const DEFAULTS: Settings = {
  owner: '',
  repo: '',
  token: '',
  secret: '',
  pollMs: 10_000,
};

function clampPoll(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULTS.pollMs;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(ms)));
}

function load(): Settings {
  const raw = getJSON<Partial<Settings>>(KEY, {});
  return {
    owner: typeof raw.owner === 'string' ? raw.owner : '',
    repo: typeof raw.repo === 'string' ? raw.repo : '',
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
