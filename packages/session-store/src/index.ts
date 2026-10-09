export { SessionStoreError, throwIfAborted } from './errors.js';

export type { SessionStoreErrorCode } from './errors.js';

export {
  DEFAULT_SWEEP_AGE_MS,
  ensurePrivateDir,
  readPrivateBytes,
  readPrivateFile,
  sweepTemp,
  sweepTempInDirectory,
  writePrivateFile,
} from './files.js';

export type { DirectoryOptions, ReadOptions, SweepOptions, WriteOptions } from './files.js';

export { DEFAULT_WAIT_MS, withFileLock } from './lock.js';

export type { LockOptions } from './lock.js';

export {
  TEST_SEAM,
  defaultKeyProvider,
  defaultSecretRecordPath,
  defaultSessionPath,
  retiredStorePaths,
  testSeam,
} from './paths.js';

export type { DefaultKeyProviderOptions, SessionPathOptions, StorePathOptions } from './paths.js';

export { FakeKeyProvider, KEY_BYTES, LocalKeyFileProvider } from './keys.js';

export type { KeyProvider, LocalKeyFileOptions } from './keys.js';

export {
  checkSecretStore,
  createSecretKey,
  existingPaths,
  readSecretRecord,
  resetSecretStore,
  secretStoreExists,
  withSecretRecord,
  withSecretStore,
} from './secret.js';

export type { SecretRecordOptions, SecretStore, SecretUpdate, StoreCheck } from './secret.js';

export { StoreRefusal } from './storage.js';
