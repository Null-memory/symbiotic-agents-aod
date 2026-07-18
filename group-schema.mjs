const LEGACY_AGENT_UNIQUE = /UNIQUE\s*\(\s*group_id\s*,\s*agent\s*\)/i;

export function migrateAgentGroupMembers(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_group_members'").get();
  if (!table?.sql || !LEGACY_AGENT_UNIQUE.test(table.sql)) return false;

  const foreignKeysEnabled = Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1;
  if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE agent_group_members_v3 (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        agent TEXT NOT NULL,
        role TEXT NOT NULL,
        display_name TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(group_id, key)
      );
      INSERT INTO agent_group_members_v3(id, group_id, key, agent, role, display_name, instructions, position, enabled)
        SELECT id, group_id, key, agent, role, display_name, instructions, position, enabled
        FROM agent_group_members;
      DROP TABLE agent_group_members;
      ALTER TABLE agent_group_members_v3 RENAME TO agent_group_members;
      COMMIT;
    `);
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = ON');
  }
}
