/** A relative path and its SHA-256 content digest. */
export interface DigestedFile {
  readonly path: string;
  readonly sha256: string;
}

/** Canonical build-manifest representation shared by build tooling. */
export interface BuildManifest {
  readonly version: 1;
  readonly inputs: readonly DigestedFile[];
  readonly outputs: readonly DigestedFile[];
}
