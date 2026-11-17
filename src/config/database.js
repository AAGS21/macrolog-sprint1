import pg from "pg";

const { Pool } = pg;

export function createDatabasePool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("Falta DATABASE_URL");
  }

  return new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

export async function initializeDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email VARCHAR(320) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL
        CHECK (role IN ('user', 'admin')),
      confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS users_email_index
      ON users (email);

    CREATE TABLE IF NOT EXISTS email_confirmation_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      CHECK (expires_at = created_at + INTERVAL '24 hours'),
      CHECK (used_at IS NULL OR (used_at >= created_at AND used_at < expires_at)),
      CHECK (used_at IS NULL OR revoked_at IS NULL)
    );

    -- UNIQUE ya crea el índice de búsqueda por token_hash.
    CREATE INDEX IF NOT EXISTS email_confirmation_tokens_user_created_index
      ON email_confirmation_tokens (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS email_confirmation_tokens_expires_index
      ON email_confirmation_tokens (expires_at);

    CREATE TABLE IF NOT EXISTS meals (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      name VARCHAR(100) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
      calories BIGINT NOT NULL CHECK (calories BETWEEN 0 AND 9007199254740991),
      protein_grams NUMERIC NOT NULL CHECK (
        protein_grams BETWEEN 0 AND 90071992547409.91
        AND protein_grams = trunc(protein_grams, 2)
      ),
      meal_date DATE NOT NULL CHECK (meal_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS meals_user_date_index
      ON meals (user_id, meal_date);
  `);
}
