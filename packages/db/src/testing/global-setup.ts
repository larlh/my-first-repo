import { setupTestDatabase } from './index';

/** vitest globalSetup entry: `globalSetup: ['@parlante/db/testing/global-setup']`. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return setupTestDatabase();
}
