const Base = require('./base.js');
const { normalizeOrder } = require('./order.js');

const TABLES = new Set(['Comment', 'Counter', 'Users']);
const COLUMNS = {
  Comment: new Set([
    'id',
    'user_id',
    'comment',
    'insertedAt',
    'ip',
    'link',
    'mail',
    'nick',
    'rid',
    'pid',
    'sticky',
    'status',
    'like',
    'ua',
    'url',
    'createdAt',
    'updatedAt',
  ]),
  Counter: new Set([
    'id',
    'time',
    'reaction0',
    'reaction1',
    'reaction2',
    'reaction3',
    'reaction4',
    'reaction5',
    'reaction6',
    'reaction7',
    'reaction8',
    'url',
    'createdAt',
    'updatedAt',
  ]),
  Users: new Set([
    'id',
    'display_name',
    'email',
    'password',
    'type',
    'label',
    'github',
    'twitter',
    'facebook',
    'google',
    'weibo',
    'qq',
    'oidc',
    'huawei',
    '2fa',
    'avatar',
    'url',
    'createdAt',
    'updatedAt',
  ]),
};

const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;

module.exports = class extends Base {
  constructor(tableName) {
    super(tableName);
    if (!TABLES.has(tableName)) {
      throw new TypeError(`Unsupported D1 table: ${tableName}`);
    }
    this.db = think.config('d1');
    if (!this.db) {
      throw new Error('D1 binding is unavailable.');
    }
  }

  column(name) {
    const normalized = name === 'objectId' || name === 'objectid' ? 'id' : name;
    if (!COLUMNS[this.tableName].has(normalized)) {
      throw new TypeError(`Unsupported D1 column: ${name}`);
    }
    return normalized;
  }

  compileWhere(filter = {}) {
    if (think.isEmpty(filter)) return { sql: '1 = 1', values: [] };

    const clauses = [];
    const values = [];
    let logic = 'AND';

    for (const [key, value] of Object.entries(filter)) {
      if (key === '_logic') {
        logic = String(value).toUpperCase() === 'OR' ? 'OR' : 'AND';
        continue;
      }
      if (key === '_complex') {
        const nested = this.compileWhere(value);
        clauses.push(`(${nested.sql})`);
        values.push(...nested.values);
        continue;
      }

      const field = quote(this.column(key));
      if (value === undefined || value === null) {
        clauses.push(`${field} IS NULL`);
        continue;
      }
      if (!Array.isArray(value)) {
        clauses.push(`${field} = ?`);
        values.push(this.serialize(value));
        continue;
      }

      const operator = String(value[0]).toUpperCase();
      const operand = value[1];
      if (operator === 'IN' || operator === 'NOT IN') {
        if (!Array.isArray(operand) || operand.length === 0) {
          clauses.push(operator === 'IN' ? '0 = 1' : '1 = 1');
        } else {
          clauses.push(`${field} ${operator} (SELECT value FROM json_each(?))`);
          values.push(JSON.stringify(operand.map((item) => this.serialize(item))));
        }
      } else if (['>', '>=', '<', '<=', '!=', '<>', 'LIKE', 'NOT LIKE'].includes(operator)) {
        clauses.push(`${field} ${operator} ?`);
        values.push(this.serialize(operand));
      } else {
        throw new TypeError(`Unsupported D1 operator: ${operator}`);
      }
    }

    return {
      sql: clauses.length > 0 ? clauses.join(` ${logic} `) : '1 = 1',
      values,
    };
  }

  serialize(value) {
    if (think.isDate(value)) return think.datetime(value);
    if (typeof value === 'boolean') return Number(value);
    return value;
  }

  normalize(row) {
    if (!row) return row;
    const { id, ...data } = row;
    return { ...data, objectId: id };
  }

  async select(where, { desc, limit, offset, field, order } = {}) {
    const condition = this.compileWhere(where);
    const selected = field?.length
      ? [...new Set([...field.map((item) => this.column(item)), 'id'])].map(quote).join(', ')
      : '*';
    let sql = `SELECT ${selected} FROM ${quote(`wl_${this.tableName}`)} WHERE ${condition.sql}`;
    const ordering = normalizeOrder(order, desc, (name) => this.column(name));
    if (ordering.length) {
      sql += ` ORDER BY ${ordering
        .map(({ field: name, direction, nulls }) =>
          `${quote(name)} ${direction.toUpperCase()}${nulls ? ` NULLS ${nulls.toUpperCase()}` : ''}`,
        )
        .join(', ')}`;
    }
    if (limit || offset) {
      sql += ' LIMIT ? OFFSET ?';
      condition.values.push(limit ?? -1, offset ?? 0);
    }

    const result = await this.db
      .prepare(sql)
      .bind(...condition.values)
      .all();
    return result.results.map((row) => this.normalize(row));
  }

  async count(where = {}, { group } = {}) {
    const condition = this.compileWhere(where);
    if (!group?.length) {
      const result = await this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM ${quote(`wl_${this.tableName}`)} WHERE ${condition.sql}`,
        )
        .bind(...condition.values)
        .first();
      return result?.count ?? 0;
    }

    const fields = group.map((item) => quote(this.column(item)));
    const result = await this.db
      .prepare(
        `SELECT ${fields.join(', ')}, COUNT(*) AS count
         FROM ${quote(`wl_${this.tableName}`)}
         WHERE ${condition.sql}
         GROUP BY ${fields.join(', ')}`,
      )
      .bind(...condition.values)
      .all();
    return result.results;
  }

  async add(data) {
    const record = { ...data };
    if (record.objectId) {
      record.id = record.objectId;
      delete record.objectId;
    }
    const date = new Date();
    record.createdAt ??= date;
    record.updatedAt ??= date;

    const entries = Object.entries(record).map(([key, value]) => [
      this.column(key),
      this.serialize(value),
    ]);
    const result = await this.db
      .prepare(
        `INSERT INTO ${quote(`wl_${this.tableName}`)}
         (${entries.map(([key]) => quote(key)).join(', ')})
         VALUES (${entries.map(() => '?').join(', ')})
         RETURNING *`,
      )
      .bind(...entries.map(([, value]) => value))
      .first();
    return this.normalize(result);
  }

  async update(data, where) {
    const existing = await this.select(where);
    return Promise.all(
      existing.map(async (item) => {
        const updateData = typeof data === 'function' ? data(item) : data;
        const entries = Object.entries(updateData).map(([key, value]) => [
          this.column(key),
          this.serialize(value),
        ]);
        if (entries.length === 0) return item;

        const result = await this.db
          .prepare(
            `UPDATE ${quote(`wl_${this.tableName}`)}
             SET ${entries.map(([key]) => `${quote(key)} = ?`).join(', ')}
             WHERE id = ?
             RETURNING *`,
          )
          .bind(...entries.map(([, value]) => value), item.objectId)
          .first();
        return this.normalize(result);
      }),
    );
  }

  async delete(where) {
    const condition = this.compileWhere(where);
    const result = await this.db
      .prepare(`DELETE FROM ${quote(`wl_${this.tableName}`)} WHERE ${condition.sql}`)
      .bind(...condition.values)
      .run();
    return result.meta.changes;
  }

  async setSeqId(id) {
    await this.db
      .prepare(
        `INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET seq = excluded.seq`,
      )
      .bind(`wl_${this.tableName}`, id)
      .run();
  }
};
