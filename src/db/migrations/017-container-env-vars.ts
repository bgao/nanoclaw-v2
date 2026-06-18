import type { Migration } from './index.js';

// Renumbered from 016 → 017 during the v2.1.x merge: upstream took 016 for
// `messaging-group-instance`. The `name` stays '016-container-env-vars' so
// installs that already applied it (tracking is keyed on name) don't re-run it.
export const migration017: Migration = {
  version: 17,
  name: '016-container-env-vars',
  up: (db) => {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}'`);
  },
};
