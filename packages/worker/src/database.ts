export type Row = Record<string, unknown> & { id: number };
export const TABLES = {
  Comment: 'wl_Comment',
  Counter: 'wl_Counter',
  Users: 'wl_Users',
} as const;

export const normalize = <T extends Row>(row: T) => {
  const { id, ...rest } = row;
  return { ...rest, objectId: id };
};

export async function all<T extends Row>(
  db: D1Database,
  table: keyof typeof TABLES,
  order = '',
) {
  const result = await db.prepare(`SELECT * FROM "${TABLES[table]}" ${order}`).all<T>();
  return result.results.map(normalize);
}

export async function byId<T extends Row>(
  db: D1Database,
  table: keyof typeof TABLES,
  id: number,
) {
  const row = await db
    .prepare(`SELECT * FROM "${TABLES[table]}" WHERE id = ?`)
    .bind(id)
    .first<T>();
  return row ? normalize(row) : null;
}

export async function insert(
  db: D1Database,
  table: keyof typeof TABLES,
  data: Record<string, unknown>,
) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const row = await db
    .prepare(
      `INSERT INTO "${TABLES[table]}" (${entries.map(([key]) => `"${key}"`).join(',')})
       VALUES (${entries.map(() => '?').join(',')}) RETURNING *`,
    )
    .bind(...entries.map(([, value]) => value))
    .first<Row>();
  return row ? normalize(row) : null;
}

export async function update(
  db: D1Database,
  table: keyof typeof TABLES,
  id: number,
  data: Record<string, unknown>,
) {
  const entries = Object.entries(data).filter(
    ([key, value]) => key !== 'objectId' && key !== 'id' && value !== undefined,
  );
  if (entries.length === 0) return byId(db, table, id);
  const row = await db
    .prepare(
      `UPDATE "${TABLES[table]}" SET ${entries.map(([key]) => `"${key}" = ?`).join(',')},
       updatedAt = datetime('now') WHERE id = ? RETURNING *`,
    )
    .bind(...entries.map(([, value]) => value), id)
    .first<Row>();
  return row ? normalize(row) : null;
}
