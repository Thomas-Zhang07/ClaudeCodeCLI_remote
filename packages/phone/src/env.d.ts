/// <reference types="vite/client" />

/**
 * Non-secret build-time defaults, read from the repository's `.env`.
 *
 * Only these three are exposed. Adding the token or the signing secret here
 * would bake a credential into a publicly served bundle.
 */
interface ImportMetaEnv {
  readonly VITE_CCR_OWNER?: string;
  readonly VITE_CCR_REPO?: string;
  readonly VITE_CCR_POLL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
