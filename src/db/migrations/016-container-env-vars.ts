import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: '016-container-env-vars',
  up: (db) => {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}'`);
  },
};
