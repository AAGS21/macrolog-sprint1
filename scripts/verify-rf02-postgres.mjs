import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDatabasePool, initializeDatabase } from "../src/config/database.js";
import { PostgresUserRepository } from "../src/repositories/postgresUser.repository.js";
import {
  TOKEN_COOLDOWN_MS, TOKEN_DAILY_LIMIT, TOKEN_LIFETIME_MS
} from "../src/repositories/emailConfirmationToken.js";

// Ejecutar manualmente después de revisar el host de la rama en Neon.
// No carga .env. Nunca muestra URL, contraseña, hashes ni tokens originales.
class VerificationError extends Error {}

function check(condition, message) {
  if (!condition) throw new VerificationError(message);
}

function safeError(error) {
  if (error instanceof VerificationError) return error.message;
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,30}$/.test(error.code)
    ? ` (código ${error.code})` : "";
  // Los errores de PostgreSQL pueden contener el hash duplicado en detail/message.
  return `Error de ejecución${code}; se omiten mensaje, detalle y stack para proteger secretos.`;
}

function connectionTarget(databaseUrl) {
  check(databaseUrl, "Falta DATABASE_URL en el entorno; no se leerán archivos .env.");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new VerificationError("DATABASE_URL no tiene un formato válido; no se mostrará su contenido.");
  }
  check(["postgres:", "postgresql:"].includes(parsed.protocol), "Se requiere una URL PostgreSQL.");
  check(parsed.hostname && !parsed.hostname.toLowerCase().includes("-pooler"),
    "Se requiere un hostname directo, sin -pooler.");
  // Evita que los parámetros de la URL sustituyan el destino que se muestra.
  const overrides = ["host", "hostaddr", "port", "database", "dbname", "user", "username", "password"];
  check(![...parsed.searchParams.keys()].some((key) => overrides.includes(key.toLowerCase())),
    "La URL no debe sobrescribir host, base de datos o credenciales mediante parámetros.");
  let database;
  let user;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    user = decodeURIComponent(parsed.username);
  } catch {
    throw new VerificationError("La base de datos o el usuario contienen una codificación inválida.");
  }
  check(database && user, "DATABASE_URL debe indicar explícitamente base de datos y usuario.");
  return { host: parsed.hostname, database, user };
}

async function identity(queryable, target) {
  const { rows: [row] } = await queryable.query(
    "SELECT current_database() AS database, current_user AS username"
  );
  check(row.database === target.database && row.username === target.user,
    "La identidad SQL no coincide con el destino mostrado. Se detiene la verificación.");
  return row;
}

async function relationIds(queryable) {
  const { rows: [row] } = await queryable.query(
    `SELECT to_regclass($1)::oid::text AS tokens,
            to_regclass($2)::oid::text AS users,
            to_regclass($3)::oid::text AS meals`,
    ["email_confirmation_tokens", "users", "meals"]
  );
  check(row.tokens && row.users && row.meals, "Falta alguna de las tablas requeridas.");
  return row;
}

function sameColumns(actual, expected) {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

async function verifyCatalogs(queryable) {
  const relations = await relationIds(queryable);
  const { rows: tables } = await queryable.query(
    "SELECT oid::text, relkind FROM pg_catalog.pg_class WHERE oid = ANY($1::oid[])",
    [Object.values(relations)]
  );
  check(tables.length === 3 && tables.every((table) => table.relkind === "r"),
    "Las relaciones esperadas deben ser tablas ordinarias.");
  const { rows: columns } = await queryable.query(
    `SELECT attnum, attname, format_type(atttypid, atttypmod) AS type, attnotnull
     FROM pg_catalog.pg_attribute
     WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [relations.tokens]
  );
  const expected = [
    ["id", "uuid", true], ["user_id", "uuid", true], ["token_hash", "text", true],
    ["created_at", "timestamp with time zone", true], ["expires_at", "timestamp with time zone", true],
    ["used_at", "timestamp with time zone", false], ["revoked_at", "timestamp with time zone", false]
  ];
  check(columns.length === expected.length && expected.every(([name, type, notNull]) =>
    columns.some((column) => column.attname === name && column.type === type && column.attnotnull === notNull)),
  "Las columnas o su nulabilidad no corresponden al contrato de tokens.");
  const names = new Map(columns.map((column) => [column.attnum, column.attname]));
  const { rows: constraints } = await queryable.query(
    `SELECT contype, conkey, confrelid::text, convalidated, confdeltype,
            pg_get_constraintdef(oid) AS definition
     FROM pg_catalog.pg_constraint WHERE conrelid = $1::oid`,
    [relations.tokens]
  );
  const hasConstraint = (type, keys) => constraints.some((constraint) =>
    constraint.contype === type && constraint.convalidated &&
    sameColumns((constraint.conkey ?? []).map((key) => names.get(key)), keys));
  check(hasConstraint("p", ["id"]), "Falta la clave primaria del token.");
  check(hasConstraint("u", ["token_hash"]), "Falta la restricción única del hash.");
  check(constraints.some((constraint) => constraint.contype === "f" && constraint.convalidated &&
    constraint.confrelid === relations.users && sameColumns(constraint.conkey.map((key) => names.get(key)), ["user_id"]) &&
    /REFERENCES\s+(?:\S+\.)?users\(id\)/i.test(constraint.definition)),
  "Falta la clave foránea de los tokens hacia users(id).");
  const checks = constraints.filter((constraint) => constraint.contype === "c" && constraint.convalidated)
    .map((constraint) => constraint.definition.replace(/[()\s"]/g, "").toLowerCase());
  check(checks.some((definition) => definition.includes("token_hash~'^[0-9a-f]{64}$'")),
    "Falta la restricción de formato SHA-256.");
  check(checks.some((definition) => definition.includes("expires_at=created_at+") &&
    /'(24:00:00|24hours)'::interval/.test(definition)), "Falta la caducidad SQL de 24 horas.");
  check(checks.some((definition) => definition.includes("used_atisnullorused_at>=created_atandused_at<expires_at")),
    "Falta la restricción de fecha de consumo.");
  check(checks.some((definition) => definition.includes("used_atisnullorrevoked_atisnull")),
    "Falta la exclusión entre consumo y revocación.");
  const { rows: indexes } = await queryable.query(
    `SELECT idx.indisunique, idx.indisprimary, idx.indisvalid, idx.indisready,
            idx.indpred IS NULL AS complete, idx.indexprs IS NULL AS simple,
            pg_get_indexdef(idx.indexrelid) AS definition,
            ARRAY(SELECT attribute.attname::text
                  FROM unnest(idx.indkey) WITH ORDINALITY AS entry(attnum, ordinal)
                  JOIN pg_catalog.pg_attribute AS attribute
                    ON attribute.attrelid = idx.indrelid AND attribute.attnum = entry.attnum
                  WHERE entry.ordinal <= idx.indnkeyatts ORDER BY entry.ordinal) AS columns
     FROM pg_catalog.pg_index AS idx WHERE idx.indrelid = $1::oid`,
    [relations.tokens]
  );
  const hasIndex = (keys, predicate = () => true) => indexes.some((index) =>
    index.indisvalid && index.indisready && index.complete && index.simple &&
    sameColumns(index.columns, keys) && predicate(index));
  check(hasIndex(["id"], (index) => index.indisprimary), "Falta el índice de clave primaria.");
  check(hasIndex(["token_hash"], (index) => index.indisunique), "Falta el índice único del hash.");
  check(hasIndex(["user_id", "created_at"], (index) => /created_at DESC/.test(index.definition)),
    "Falta el índice por usuario y fecha descendente.");
  check(hasIndex(["expires_at"]), "Falta el índice por caducidad.");
  return relations;
}

// Espera también los errores de todas las operaciones antes de iniciar la limpieza.
async function concurrent(operations) {
  const outcomes = await Promise.all(operations.map(async (operation) => {
    try { return { value: await operation() }; }
    catch (error) { return { error }; }
  }));
  const failure = outcomes.find((outcome) => Object.hasOwn(outcome, "error"));
  if (failure) throw failure.error;
  return outcomes.map((outcome) => outcome.value);
}

async function cleanup(pool, target, originalRelations, users, tokens) {
  if (users.size === 0) return;
  const client = await pool.connect();
  let rollbackError;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await identity(client, target);
    const relations = await relationIds(client);
    check(Object.keys(relations).every((key) => relations[key] === originalRelations[key]),
      "Limpieza detenida: las tablas han cambiado de identidad.");
    // Impide que un DELETE sobre datos propios borre otras filas por cascada.
    const { rows: unsafeReferences } = await client.query(
      `SELECT 1 FROM pg_catalog.pg_constraint
       WHERE contype = 'f' AND confrelid = ANY($1::oid[])
         AND confdeltype NOT IN ('a', 'r') LIMIT 1`,
      [[relations.users, relations.tokens]]
    );
    check(unsafeReferences.length === 0, "Limpieza detenida: existen acciones referenciales que podrían alterar otros datos.");
    const userIds = [...users.keys()];
    const tokenIds = [...tokens.keys()];
    const { rows: storedUsers } = await client.query(
      `SELECT id, email, password_hash FROM users
       WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [userIds]
    );
    check(storedUsers.every((row) => {
      const own = users.get(row.id);
      return own && own.email === row.email && own.passwordHash === row.password_hash;
    }), "Limpieza detenida: no se puede demostrar la propiedad de un usuario.");
    const { rows: meals } = await client.query(
      "SELECT 1 FROM meals WHERE user_id = ANY($1::uuid[]) LIMIT 1", [userIds]
    );
    check(meals.length === 0, "Limpieza detenida: un usuario de prueba tiene comidas; no se borrará ningún usuario.");
    const { rows: storedTokens } = await client.query(
      `SELECT id, user_id, token_hash FROM email_confirmation_tokens
       WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
      [userIds, tokenIds]
    );
    check(storedTokens.every((row) => {
      const own = tokens.get(row.id);
      return own && own.userId === row.user_id && own.tokenHash === row.token_hash;
    }), "Limpieza detenida: hay tokens cuya propiedad no se puede demostrar.");
    const deletedTokens = await client.query(
      `DELETE FROM email_confirmation_tokens
       WHERE user_id = ANY($1::uuid[]) AND id = ANY($2::uuid[]) RETURNING id`,
      [userIds, tokenIds]
    );
    check(deletedTokens.rowCount === storedTokens.length, "Limpieza detenida: el número de tokens no coincide.");
    const deletedUsers = await client.query("DELETE FROM users WHERE id = ANY($1::uuid[]) RETURNING id", [userIds]);
    check(deletedUsers.rowCount === storedUsers.length, "Limpieza detenida: el número de usuarios no coincide.");
    const { rows: [remaining] } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM users WHERE id = ANY($1::uuid[])) AS users,
              EXISTS(SELECT 1 FROM email_confirmation_tokens
                     WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])) AS tokens`,
      [userIds, tokenIds]
    );
    check(!remaining.users && !remaining.tokens, "Limpieza detenida: quedan datos de la ejecución.");
    await client.query("COMMIT");
    console.log("Limpieza confirmada: eliminados exclusivamente los usuarios y tokens propios. Se conserva el esquema.");
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (failure) { rollbackError = failure; }
    throw error;
  } finally {
    client.release(rollbackError);
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const target = connectionTarget(databaseUrl);
  console.log(`Destino: host=${JSON.stringify(target.host)}, database=${JSON.stringify(target.database)}, usuario=${JSON.stringify(target.user)}`);
  console.log("SQL no permite certificar el nombre de la rama de Neon: comprueba que este hostname coincide con el mostrado en Neon para la rama elegida.");
  console.log("Tras confirmar se inicializará el esquema y se crearán datos de prueba. La limpieza conserva tablas e índices.");
  check(stdin.isTTY && stdout.isTTY, "Se requiere una terminal interactiva; no se admite confirmación por tubería.");
  const users = new Map();
  const tokens = new Map();
  const pools = [];
  const poolErrors = [];
  const runId = randomUUID();
  let current;
  let relations;
  let approved = false;
  let verified = false;
  let cleanupFailed = false;
  const openPool = () => {
    const pool = createDatabasePool(databaseUrl);
    const record = { pool, closing: null };
    pools.push(record);
    pool.on("error", (error) => poolErrors.push(error));
    current = record;
    check(pool.options.max >= 5, "El pool debe permitir al menos cinco conexiones simultáneas.");
    return pool;
  };
  const closePool = async (record) => {
    record.closing ??= record.pool.end();
    await record.closing;
  };
  const report = (number, message) => {
    if (poolErrors.length > 0) throw poolErrors[0];
    console.log(`OK ${number}/10: ${message}`);
  };
  const reserveUser = async (pool) => {
    const id = randomUUID();
    const user = {
      id, email: `rf02-${id}@example.invalid`,
      passwordHash: randomBytes(32).toString("hex"),
      role: "user", confirmed: false, deletedAt: null
    };
    const { rows: [row] } = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 OR email = $2) AS present", [id, user.email]
    );
    check(!row.present && !users.has(id), "Colisión previa de UUID o correo; no se escribirá ese usuario.");
    // Se registra antes del intento: permite limpiar incluso un COMMIT de resultado incierto.
    users.set(id, user);
    console.log(`UUID de usuario reservado para esta ejecución: ${id}`);
    return user;
  };
  const reserveToken = async (pool, userId, duplicateHash) => {
    const original = randomBytes(32);
    const tokenHash = duplicateHash ?? createHash("sha256").update(original).digest("hex");
    original.fill(0);
    const token = { id: randomUUID(), tokenHash };
    const { rows: [row] } = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM email_confirmation_tokens WHERE id = $1) AS id_present,
              EXISTS(SELECT 1 FROM email_confirmation_tokens WHERE token_hash = $2) AS hash_present`,
      [token.id, tokenHash]
    );
    check(!row.id_present && !tokens.has(token.id) && (duplicateHash || !row.hash_present),
      "Colisión previa de UUID o hash; no se escribirá ese token.");
    tokens.set(token.id, { ...token, userId });
    return token;
  };

  try {
    let pool = openPool();
    const serverIdentity = await identity(pool, target);
    console.log(`Identidad SQL: current_database()=${JSON.stringify(serverIdentity.database)}, current_user=${JSON.stringify(serverIdentity.username)}`);
    const prompt = createInterface({ input: stdin, output: stdout });
    let answer;
    try {
      answer = await prompt.question("Verifica el hostname en Neon y escribe exactamente rf02-verification para continuar: ");
    } finally {
      prompt.close();
    }
    check(answer === "rf02-verification", "Confirmación incorrecta o cancelada: no se inicializó ni escribió ningún dato.");
    approved = true;
    console.log(`Ejecución RF-02: ${runId}`);

    await initializeDatabase(pool);
    await initializeDatabase(pool);
    // Verifica el esquema antes de crear fixtures; vuelve a comprobarlo en el paso 10.
    relations = await verifyCatalogs(pool);
    report(1, "inicialización ejecutada dos veces y esquema compatible.");

    let repository = new PostgresUserRepository(pool);
    const user = await reserveUser(pool);
    const initial = await reserveToken(pool, user.id);
    const start = new Date();
    const at = (offset) => new Date(start.getTime() + offset);
    const clock = (offset) => () => at(offset);
    const created = await repository.createPendingWithToken(user, initial, start);
    check(created.user.id === user.id && created.user.confirmed === false &&
      created.token.userId === user.id && created.token.tokenHash === initial.tokenHash &&
      created.token.expiresAt === at(TOKEN_LIFETIME_MS).toISOString(), "El alta pendiente o la asociación inicial son incorrectas.");
    report(2, "usuario pendiente y primer token asociados, con vigencia de 24 horas.");

    await closePool(current);
    pool = openPool();
    await identity(pool, target);
    repository = new PostgresUserRepository(pool);
    const persistedUser = await repository.findById(user.id);
    const persistedToken = await repository.findConfirmationTokenByHash(initial.tokenHash);
    check(persistedUser?.id === user.id && persistedUser.email === user.email &&
      persistedUser.passwordHash === user.passwordHash && persistedUser.confirmed === false &&
      persistedToken?.id === initial.id && persistedToken.userId === user.id &&
      persistedToken.tokenHash === initial.tokenHash && persistedToken.usedAt === null && persistedToken.revokedAt === null,
    "Los datos no persisten correctamente después de cerrar y reabrir el pool.");
    report(3, "persistencia verificada desde un pool nuevo.");

    const rollbackUser = await reserveUser(pool);
    const duplicate = await reserveToken(pool, rollbackUser.id, initial.tokenHash);
    let rollbackError;
    try { await repository.createPendingWithToken(rollbackUser, duplicate, start); }
    catch (error) { rollbackError = error; }
    check(rollbackError?.code === "23505", "El hash duplicado debe provocar PostgreSQL 23505.");
    check(await repository.findById(rollbackUser.id) === null, "Rollback incorrecto: quedó persistido el segundo usuario.");
    const { rows: [rolledBackToken] } = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM email_confirmation_tokens WHERE id = $1) AS present", [duplicate.id]
    );
    check(!rolledBackToken.present, "Rollback incorrecto: quedó persistido el segundo token.");
    report(4, "error 23505 y rollback real sin usuario ni token residuales.");

    const rejected = await reserveToken(pool, user.id);
    check(await repository.issueConfirmationToken(user.id, rejected, clock(59999)) === null,
      "El cooldown debe rechazar una emisión a los 59.999 ms.");
    const second = await reserveToken(pool, user.id);
    check((await repository.issueConfirmationToken(user.id, second, clock(60000)))?.id === second.id,
      "El cooldown debe permitir una emisión a los 60.000 ms.");
    report(5, "cooldown de 60 segundos, incluida la emisión inicial.");

    const candidates = [];
    for (let i = 0; i < 5; i++) candidates.push(await reserveToken(pool, user.id));
    const issued = await concurrent(candidates.map((token) =>
      () => repository.issueConfirmationToken(user.id, token, clock(2 * TOKEN_COOLDOWN_MS))));
    check(issued.filter(Boolean).length === 1 && issued.every((token) => token === null || token.userId === user.id),
      "Cinco emisiones simultáneas deben producir exactamente un token.");
    const activeTokens = [created.token, await repository.findConfirmationTokenByHash(second.tokenHash), ...issued.filter(Boolean)];
    report(6, "cinco emisiones concurrentes con Promise.all: exactamente una aceptada.");

    for (let i = activeTokens.length; i < TOKEN_DAILY_LIMIT; i++) {
      const token = await reserveToken(pool, user.id);
      const result = await repository.issueConfirmationToken(user.id, token, clock(i * TOKEN_COOLDOWN_MS));
      check(result, "No se pudieron completar las cinco emisiones permitidas.");
      activeTokens.push(result);
    }
    const sixth = await reserveToken(pool, user.id);
    check(await repository.issueConfirmationToken(user.id, sixth, clock(5 * TOKEN_COOLDOWN_MS)) === null,
      "La sexta emisión dentro de 24 horas debe rechazarse.");
    check(await repository.issueConfirmationToken(user.id, sixth, clock(TOKEN_LIFETIME_MS - 1)) === null,
      "La cuota debe seguir completa un milisegundo antes de las 24 horas.");
    const { rows: [count] } = await pool.query(
      "SELECT COUNT(*)::int AS total FROM email_confirmation_tokens WHERE user_id = $1", [user.id]
    );
    check(count.total === TOKEN_DAILY_LIMIT, "Deben existir exactamente cinco emisiones, incluida la inicial.");
    const renewed = await repository.issueConfirmationToken(user.id, sixth, clock(TOKEN_LIFETIME_MS));
    check(renewed?.id === sixth.id, "La ventana móvil debe liberar la emisión inicial exactamente a las 24 horas.");
    activeTokens.push(renewed);
    report(7, "límite de cinco, sexta rechazada y liberación de cuota en la ventana móvil.");

    const confirmationTime = TOKEN_LIFETIME_MS + 1000;
    const confirmations = await concurrent(Array.from({ length: 2 }, () =>
      () => repository.confirmWithToken(sixth.tokenHash, clock(confirmationTime))));
    check(confirmations.filter((result) => result?.id === user.id && result.confirmed === true).length === 1 &&
      confirmations.filter((result) => result === null).length === 1,
    "La confirmación simultánea del mismo token debe activar la cuenta una sola vez.");
    check((await repository.findById(user.id))?.confirmed === true, "La cuenta no quedó confirmada.");
    report(8, "dos confirmaciones concurrentes del mismo token: exactamente una aceptada.");

    for (const token of activeTokens) {
      const stored = await repository.findConfirmationTokenByHash(token.tokenHash);
      check(stored?.id === token.id && stored.userId === user.id, "Falta un token propio después de confirmar.");
      if (token.id === sixth.id) {
        check(stored.usedAt === at(confirmationTime).toISOString() && stored.revokedAt === null,
          "El token usado debe quedar consumido, sin revocación.");
      } else {
        check(stored.usedAt === null && stored.revokedAt === at(confirmationTime).toISOString(),
          "Todos los demás tokens deben quedar revocados, incluido el inicial caducado.");
      }
    }
    check(await repository.confirmWithToken(sixth.tokenHash, clock(confirmationTime + 1)) === null,
      "El token consumido no puede reutilizarse.");
    report(9, "consumo único y revocación de todos los tokens restantes.");
    const finalRelations = await verifyCatalogs(pool);
    check(Object.keys(relations).every((key) => relations[key] === finalRelations[key]),
      "La identidad de las tablas cambió durante la verificación.");
    report(10, "catálogos PostgreSQL: tablas, columnas, restricciones e índices verificados.");
    verified = true;
  } finally {
    try {
      if (approved && users.size > 0) {
        if (!current || current.closing || current.pool.ending || current.pool.ended) openPool();
        await cleanup(current.pool, target, relations, users, tokens);
      }
    } catch (error) {
      cleanupFailed = true;
      process.exitCode = 1;
      console.error(`No se puede garantizar la limpieza: ${safeError(error)}`);
      console.error(`Revisión manual necesaria para los UUID reservados: ${JSON.stringify([...users.keys()])}`);
      console.error("No se ampliará el borrado a datos ajenos ni se eliminarán tablas.");
    } finally {
      for (const record of pools) {
        try { await closePool(record); }
        catch (error) {
          cleanupFailed = true;
          process.exitCode = 1;
          console.error(`No se pudo confirmar el cierre de un pool: ${safeError(error)}`);
        }
      }
    }
  }
  if (verified && !cleanupFailed) console.log("RF-02: 10 verificaciones reales completadas y limpieza confirmada.");
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`Verificación detenida: ${safeError(error)}`);
});
