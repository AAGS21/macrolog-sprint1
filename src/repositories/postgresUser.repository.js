import {
  buildConfirmationToken,
  buildPendingUser,
  canIssueConfirmationToken,
  confirmationTime,
  isUsableConfirmationToken,
  normalizeTokenHash
} from "./emailConfirmationToken.js";

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    confirmed: row.confirmed,
    deletedAt: toIsoString(row.deleted_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

const SELECT_COLUMNS = `
  id,
  email,
  password_hash,
  role,
  confirmed,
  deleted_at,
  created_at,
  updated_at
`;

const TOKEN_COLUMNS = "id, user_id, token_hash, created_at, expires_at, used_at, revoked_at";

function mapConfirmationToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
    usedAt: toIsoString(row.used_at),
    revokedAt: toIsoString(row.revoked_at)
  };
}

async function insertConfirmationToken(client, token) {
  const result = await client.query(
    `INSERT INTO email_confirmation_tokens (
       id, user_id, token_hash, created_at, expires_at, used_at, revoked_at
     ) VALUES ($1, $2, $3, $4, $5, NULL, NULL)
     RETURNING ${TOKEN_COLUMNS}`,
    [token.id, token.userId, token.tokenHash, token.createdAt, token.expiresAt]
  );
  return mapConfirmationToken(result.rows[0]);
}

async function confirmationTransaction(pool, operation, { readCommitted = false } = {}) {
  const client = await pool.connect();
  let rollbackError;
  try {
    await client.query(readCommitted ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (failure) {
      rollbackError = failure;
    }
    throw error;
  } finally {
    // Un cliente cuyo ROLLBACK falla no debe volver al pool como si estuviera sano.
    client.release(rollbackError);
  }
}

export class PostgresUserRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create(user) {
    const result = await this.pool.query(
      `
        INSERT INTO users (
          id,
          email,
          password_hash,
          role,
          confirmed,
          deleted_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING ${SELECT_COLUMNS}
      `,
      [
        user.id,
        user.email,
        user.passwordHash,
        user.role,
        user.confirmed,
        user.deletedAt,
        user.createdAt,
        user.updatedAt
      ]
    );

    return mapUser(result.rows[0]);
  }

  async findById(id) {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM users
       WHERE id = $1`,
      [id]
    );

    return mapUser(result.rows[0]);
  }

  async findByEmail(email) {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM users
       WHERE email = $1`,
      [email]
    );

    return mapUser(result.rows[0]);
  }

  async findAll() {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM users
       ORDER BY created_at ASC`
    );

    return result.rows.map(mapUser);
  }

  async update(id, changes) {
    const columnNames = {
      role: "role",
      confirmed: "confirmed",
      deletedAt: "deleted_at",
      updatedAt: "updated_at"
    };

    const entries = Object.entries(changes).filter(
      ([property]) => columnNames[property]
    );

    if (entries.length === 0) {
      return this.findById(id);
    }

    const assignments = entries.map(
      ([property], index) =>
        `${columnNames[property]} = $${index + 2}`
    );

    const values = [
      id,
      ...entries.map(([, value]) => value)
    ];

    const result = await this.pool.query(
      `
        UPDATE users
        SET ${assignments.join(", ")}
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}
      `,
      values
    );

    return mapUser(result.rows[0]);
  }

  async createPendingWithToken(user, token, now) {
    const pendingUser = buildPendingUser(user, now);
    const storedToken = buildConfirmationToken(pendingUser.id, token, now);
    return confirmationTransaction(this.pool, async (client) => {
      // El repositorio existente recibe este mismo cliente para el INSERT de usuario.
      const users = new PostgresUserRepository(client);
      const createdUser = await users.create(pendingUser);
      const createdToken = await insertConfirmationToken(client, storedToken);
      return { user: createdUser, token: createdToken };
    });
  }

  async issueConfirmationToken(userId, token, clock = () => new Date()) {
    return confirmationTransaction(this.pool, async (client) => {
      // Todas las emisiones y confirmaciones bloquean primero la misma fila de usuario.
      const account = await client.query(
        `SELECT confirmed, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );
      const user = account.rows[0];
      if (!user || user.confirmed || user.deleted_at) return null;
      const time = confirmationTime(clock());
      const storedToken = buildConfirmationToken(userId, token, time);
      const history = await client.query(
        `SELECT COUNT(*) AS issued_count, MAX(created_at) AS last_created_at
         FROM email_confirmation_tokens
         WHERE user_id = $1 AND created_at > $2::timestamptz - INTERVAL '24 hours'`,
        [userId, time]
      );
      const { issued_count: count, last_created_at: last } = history.rows[0];
      if (!canIssueConfirmationToken(Number(count), toIsoString(last), time)) return null;
      return insertConfirmationToken(client, storedToken);
    }, { readCommitted: true });
  }

  async findConfirmationTokenByHash(hash) {
    const normalized = normalizeTokenHash(hash);
    if (!normalized) return null;
    const result = await this.pool.query(
      `SELECT ${TOKEN_COLUMNS} FROM email_confirmation_tokens WHERE token_hash = $1`,
      [normalized]
    );
    return mapConfirmationToken(result.rows[0]);
  }

  async findValidConfirmationToken(hash, now) {
    const time = confirmationTime(now);
    const normalized = normalizeTokenHash(hash);
    if (!normalized) return null;
    const result = await this.pool.query(
      `SELECT token.id, token.user_id, token.token_hash, token.created_at,
              token.expires_at, token.used_at, token.revoked_at
       FROM email_confirmation_tokens AS token
       JOIN users AS account ON account.id = token.user_id
       WHERE token.token_hash = $1 AND token.created_at <= $2 AND token.expires_at > $2
         AND token.used_at IS NULL AND token.revoked_at IS NULL
         AND account.confirmed = FALSE AND account.deleted_at IS NULL`,
      [normalized, time]
    );
    return mapConfirmationToken(result.rows[0]);
  }

  async confirmWithToken(hash, clock = () => new Date()) {
    const normalized = normalizeTokenHash(hash);
    if (!normalized) return null;
    return confirmationTransaction(this.pool, async (client) => {
      const owner = await client.query(
        "SELECT user_id FROM email_confirmation_tokens WHERE token_hash = $1",
        [normalized]
      );
      if (!owner.rows[0]) return null;
      const userId = owner.rows[0].user_id;
      const account = await client.query(
        `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );
      const user = account.rows[0];
      if (!user || user.confirmed || user.deleted_at) return null;
      const found = await client.query(
        `SELECT ${TOKEN_COLUMNS} FROM email_confirmation_tokens
         WHERE token_hash = $1 AND user_id = $2 FOR UPDATE`,
        [normalized, userId]
      );
      const token = mapConfirmationToken(found.rows[0]);
      const time = confirmationTime(clock());
      if (!isUsableConfirmationToken(token, time)) return null;

      const updated = await client.query(
        `UPDATE users SET confirmed = TRUE, updated_at = $2
         WHERE id = $1 AND confirmed = FALSE AND deleted_at IS NULL
         RETURNING ${SELECT_COLUMNS}`,
        [userId, time]
      );
      if (!updated.rows[0]) return null;
      await client.query(
        "UPDATE email_confirmation_tokens SET used_at = $2 WHERE id = $1",
        [token.id, time]
      );
      await client.query(
        `UPDATE email_confirmation_tokens SET revoked_at = $2
         WHERE user_id = $1 AND id <> $3 AND used_at IS NULL AND revoked_at IS NULL`,
        [userId, time, token.id]
      );
      return mapUser(updated.rows[0]);
    }, { readCommitted: true });
  }
}
