/** Minimal Meteor package-descriptor host used before application compilation. */
declare const Package: {
  describe(metadata: Readonly<Record<string, unknown>>): void;
  onUse(callback: (api: MeteorPackageApi) => void): void;
  onTest(callback: (api: MeteorPackageApi) => void): void;
};

/** Stable subset of the Meteor package API consumed by local descriptors. */
interface MeteorPackageApi {
  versionsFrom(version: string): void;
  use(packages: string | readonly string[], where?: string | readonly string[]): void;
  imply(packages: string | readonly string[], where?: string | readonly string[]): void;
  mainModule(file: string, where?: string | readonly string[]): void;
  addFiles(files: string | readonly string[], where?: string | readonly string[]): void;
}

declare module '*.html';
