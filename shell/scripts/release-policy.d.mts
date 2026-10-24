export const RELEASE_BYTES: number;
export const ARTIFACT_BYTES: number;
export type MacRelease = Readonly<{ schema: 'rushes.mac-release/1'; appId: 'com.nexai.rushes';
  platform: 'darwin'; arch: 'arm64'; version: string; releaseDate: string;
  files: ReadonlyArray<Readonly<{ url: string; size: number; sha512: string }>> }>;
export type MacUpdatePolicy = Readonly<{ schema: 'rushes.mac-updates/1'; enabled: false }>
  | Readonly<{ schema: 'rushes.mac-updates/1'; enabled: true; feedURL: string }>;
export function releaseVersion(value: unknown): string;
export function publicReleaseURL(value: unknown): string;
export function releaseArtifact(version: string, extension: string): string;
export function validateRelease(value: unknown): MacRelease;
export function validateUpdatePolicy(value: unknown): MacUpdatePolicy;
