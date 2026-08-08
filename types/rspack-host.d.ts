declare module '@meteorjs/rspack' {
  /** Minimal pre-compilation host contract used by the dashboard config. */
  export function defineConfig(
    factory: (meteorFlags: Readonly<Record<string, boolean>>) => Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
}
