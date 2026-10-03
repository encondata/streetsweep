import type pg from "pg";

export async function audit(
  db: pg.Pool | pg.PoolClient,
  e: { userId?: string | null; teamId?: string | null; action: string; entity?: string; entityId?: string; data?: unknown },
) {
  await db.query(
    `INSERT INTO audit_log (user_id, team_id, action, entity, entity_id, data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.userId ?? null, e.teamId ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.data == null ? null : JSON.stringify(e.data)],
  );
}
