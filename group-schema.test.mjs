import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrateAgentGroupMembers } from './group-schema.mjs';

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
    CREATE TABLE agent_group_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      agent TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(group_id, key),
      UNIQUE(group_id, agent)
    );
    INSERT INTO agent_groups(id) VALUES ('G-001');
    INSERT INTO agent_group_members(id, group_id, key, agent, role, display_name, instructions, position, enabled)
      VALUES ('G-001-M1', 'G-001', 'claude-builder', 'claude-code', 'executor', 'Claude Builder', 'Build', 0, 1);
  `);
  return db;
}

test('migrates legacy group members to allow repeated adapters without weakening seat keys', () => {
  const db = legacyDatabase();
  const insert = db.prepare(`INSERT INTO agent_group_members
    (id, group_id, key, agent, role, display_name, instructions, position, enabled)
    VALUES (?, 'G-001', ?, ?, ?, ?, '', ?, 1)`);

  assert.throws(
    () => insert.run('G-001-M2', 'claude-critic', 'claude-code', 'reviewer', 'Claude Critic', 1),
    /unique/i,
  );

  assert.equal(migrateAgentGroupMembers(db), true);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_group_members').get().count, 1);

  db.prepare(`INSERT INTO agent_group_members
    (id, group_id, key, agent, role, display_name, instructions, position, enabled)
    VALUES (?, 'G-001', ?, ?, ?, ?, '', ?, 1)`)
    .run('G-001-M2', 'claude-critic', 'claude-code', 'reviewer', 'Claude Critic', 1);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_group_members WHERE agent = 'claude-code'").get().count, 2);
  assert.throws(
    () => db.prepare(`INSERT INTO agent_group_members
      (id, group_id, key, agent, role, display_name, instructions, position, enabled)
      VALUES ('G-001-M3', 'G-001', 'claude-critic', 'codex', 'advisor', 'Duplicate Key', '', 2, 1)`).run(),
    /unique/i,
  );
  assert.equal(migrateAgentGroupMembers(db), false);
});
