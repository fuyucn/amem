export type { Storage } from '@amem/core';
export { migrate, openDatabase, configureSqliteConnection, ensureSqliteHealthy } from './schema.js';
export {
  createSqliteStorage,
  createSqliteStorageFromPath,
  SqliteStorage,
} from './storage.js';
export {
  AuthStore,
  hashPassword,
  verifyPassword,
  hashToken,
  newPatPlaintext,
} from './authStore.js';
export type {
  UserRow,
  WorkspaceRow,
  ApiTokenRow,
  MemberRole,
  WorkspaceKind,
} from './authStore.js';
export { encryptProviderKey, decryptProviderKey } from './providerCrypto.js';

export { OauthStore } from './oauthStore.js';
