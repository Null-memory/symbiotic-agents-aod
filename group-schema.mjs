const LEGACY_AGENT_UNIQUE = /UNIQUE\s*\(\s*group_id\s*,\s*agent\s*\)/i;

export function migrateAgentGroupMembers(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_group_members'").get();
  if (!table?.sql) return false;
  if (!LEGACY_AGENT_UNIQUE.test(table.sql)) {
    const columns = new Set(db.prepare('PRAGMA table_info(agent_group_members)').all().map(column => column.name));
    if (!columns.has('profile_key')) db.exec("ALTER TABLE agent_group_members ADD COLUMN profile_key TEXT NOT NULL DEFAULT ''");
    if (!columns.has('effort')) db.exec("ALTER TABLE agent_group_members ADD COLUMN effort TEXT NOT NULL DEFAULT ''");
    return false;
  }

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
        profile_key TEXT NOT NULL DEFAULT '',
        effort TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(group_id, key)
      );
      INSERT INTO agent_group_members_v3(id, group_id, key, agent, role, display_name, instructions, profile_key, effort, position, enabled)
        SELECT id, group_id, key, agent, role, display_name, instructions, '', '', position, enabled
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
