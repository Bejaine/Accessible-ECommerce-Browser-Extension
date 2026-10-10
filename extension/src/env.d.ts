interface ImportMetaEnv {
  /** "mock" (default) serves fixtures/mocks in-browser; anything else is the backend base URL. */
  readonly VITE_BACKEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
