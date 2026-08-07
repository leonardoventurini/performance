/** Environment variables passed across benchmark process boundaries. */
export type Environment = Readonly<Record<string, string | undefined>>;
/** Parsed command-line values shared by CLI handlers. */
export interface CliValues { readonly [name: string]: string | boolean | readonly string[] | undefined; }
/** A benchmark application fixture. */
export interface AppDefinition { readonly path: string; readonly description: string; }
/** Common fields carried by every configured benchmark scenario. */
export interface ScenarioBase { readonly description: string; }
/** An Artillery-backed scenario. */
export interface ArtilleryScenario extends ScenarioBase { readonly driver: 'artillery' | 'artillery-playwright'; readonly config: string; }
/** A standalone-script benchmark scenario. */
export interface ScriptScenario extends ScenarioBase { readonly driver: 'script'; readonly script: string; readonly args?: string; readonly metric?: string; readonly strict?: boolean; }
/** A CLI-owned scenario such as cold start or bundle size. */
export interface CliScenario extends ScenarioBase { readonly driver: 'cli'; }
/** A production-build profiling scenario. */
export interface BuildProfileScenario extends ScenarioBase { readonly driver: 'build-profile'; }
/** Closed scenario union used for driver dispatch. */
export type ScenarioDefinition = ArtilleryScenario | ScriptScenario | CliScenario | BuildProfileScenario;
/** Repository benchmark configuration consumed by CLI and drivers. */
export interface BenchmarkConfig { readonly meteorCheckoutPath?: string; readonly meteorVersion?: string; readonly defaultApp: string; readonly appPort: number; readonly apps: Readonly<Record<string, AppDefinition>>; readonly scenarios: Readonly<Record<string, ScenarioDefinition>>; readonly thresholds: Readonly<Record<string, Readonly<{ warn: number; fail: number }>>>; readonly dashboardUrl: string; readonly dashboardApiKey: string; readonly results: Readonly<{ dir: string; baseline: string; history: string }>; }
/** Resolved Meteor executable and immutable source identity. */
export type MeteorSource = Readonly<{ mode: 'release'; meteorCmd: string; releaseArg: string; checkoutPath: null; version: string; sha: string }> | Readonly<{ mode: 'checkout'; meteorCmd: string; releaseArg: null; checkoutPath: string; version: string; sha: string }> | Readonly<{ mode: 'system'; meteorCmd: string; releaseArg: null; checkoutPath: null; version: string; sha: string }>;
/** Inputs shared by all benchmark drivers. */
export interface DriverInputs { readonly scenario: ScenarioDefinition; readonly scenarioName: string; readonly app: AppDefinition; readonly appName: string; readonly source: MeteorSource; readonly env: Readonly<Record<string, string>>; readonly tag: string; readonly config: BenchmarkConfig; readonly runs?: number; readonly scriptArgs?: readonly string[]; }
/** Converts an unknown thrown value into stable operator-facing text. */
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
