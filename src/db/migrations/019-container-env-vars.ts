import type { Migration } from './index.js';

// Renumbered 016 → 017 → 019 across successive upstream merges (upstream took
// 016 for `messaging-group-instance`, then 017/018 for agent-message-policies
// and approvals-approver-user-id). The `name` stays '016-container-env-vars' so
// installs that already applied it (tracking is keyed on name) don't re-run it.
export const migration019: Migration = {
  version: 19,
  name: '016-container-env-vars',
  up: (db) => {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env_vars TEXT NOT NULL DEFAULT '{}'`);
  },
};
