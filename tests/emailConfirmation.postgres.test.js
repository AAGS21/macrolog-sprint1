import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresUserRepository } from "../src/repositories/postgresUser.repository.js";
import { initializeDatabase } from "../src/config/database.js";

const START = "2026-11-17T10:00:00.000Z";
const at = (offset = 0) => new Date(Date.parse(START) + offset);
const user = {
  id: randomUUID(), email: "persistencia@example.test", passwordHash: "fixture-password-hash",
  role: "user", confirmed: false, deletedAt: null, createdAt: START, updatedAt: START
};
const token = { id: randomUUID(), tokenHash: createHash("sha256").update(randomUUID()).digest("hex") };
const userRow = {
  id: user.id, email: user.email, password_hash: user.passwordHash, role: user.role,
  confirmed: false, deleted_at: null, created_at: at(), updated_at: at()
};
const tokenRow = {
  id: token.id, user_id: user.id, token_hash: token.tokenHash, created_at: at(),
  expires_at: at(86400000), used_at: null, revoked_at: null
};
const tokenModel = {
  ...token, userId: user.id, createdAt: START, expiresAt: at(86400000).toISOString(),
  usedAt: null, revokedAt: null
};

// Solo verifican consultas, parámetros, mapeo y manejo de transacciones.
// No demuestran persistencia, bloqueos ni concurrencia con PostgreSQL real.
describe("Confirmación de cuentas: adaptador PostgreSQL con dobles SQL", () => {
  let pool;
  let client;
  let repository;
  beforeEach(() => {
    client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    pool = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn().mockResolvedValue(client) };
    repository = new PostgresUserRepository(pool);
  });

  function responses(...items) {
    for (const item of items) {
      if (item instanceof Error) client.query.mockRejectedValueOnce(item);
      else client.query.mockResolvedValueOnce({ rows: item });
    }
  }

  function statements() {
    return client.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, " ").trim());
  }

  function pauseNextQuery() {
    let release;
    let entered;
    const response = new Promise((resolve) => { release = (rows) => resolve({ rows }); });
    const waiting = new Promise((resolve) => { entered = resolve; });
    client.query.mockImplementationOnce(() => {
      entered();
      return response;
    });
    return { waiting, release };
  }

  function expectCommitted(begin = "BEGIN ISOLATION LEVEL READ COMMITTED") {
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(statements()[0]).toBe(begin);
    expect(statements().at(-1)).toBe("COMMIT");
    expect(statements()).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  }

  it("inserta usuario y hash del primer token con el mismo cliente antes del commit", async () => {
    responses([], [userRow], [tokenRow], []);
    expect(await repository.createPendingWithToken(user, token, at())).toEqual({ user, token: tokenModel });
    expectCommitted("BEGIN");
    expect(statements()[1]).toMatch(/^INSERT INTO users/);
    expect(statements()[2]).toMatch(/^INSERT INTO email_confirmation_tokens/);
    expect(client.query.mock.calls[1][1]).toEqual([
      user.id, user.email, user.passwordHash, user.role, false, null, START, START
    ]);
    expect(client.query.mock.calls[2][1]).toEqual([
      token.id, user.id, token.tokenHash, START, at(86400000).toISOString()
    ]);
  });

  it.each(["user", "token", "commit"])("solicita rollback ante fallo de %s durante el alta", async (step) => {
    const failure = Object.assign(new Error("Fallo simulado"), { code: "23505" });
    if (step === "user") responses([], failure);
    if (step === "token") responses([], [userRow], failure);
    if (step === "commit") responses([], [userRow], [tokenRow], failure);
    await expect(repository.createPendingWithToken(user, token, at())).rejects.toBe(failure);
    expect(statements().at(-1)).toBe("ROLLBACK");
    if (step !== "commit") expect(statements()).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("libera descartando el cliente si también falla el rollback, conservando el error original", async () => {
    const failure = new Error("Fallo de inserción");
    const rollbackFailure = new Error("Fallo de rollback");
    responses([], [userRow], failure, rollbackFailure);
    await expect(repository.createPendingWithToken(user, token, at())).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledWith(rollbackFailure);
  });

  it("no inicia consultas si falla la conexión", async () => {
    const failure = new Error("Conexión no disponible");
    pool.connect.mockRejectedValue(failure);
    await expect(repository.createPendingWithToken(user, token, at())).rejects.toBe(failure);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it("bloquea primero al usuario y consulta la ventana móvil antes de emitir", async () => {
    const emittedRow = { ...tokenRow, created_at: at(60000), expires_at: at(86460000) };
    responses([], [userRow], [{ issued_count: "1", last_created_at: at() }], [emittedRow], []);
    expect(await repository.issueConfirmationToken(user.id, token, () => at(60000))).toEqual({
      ...tokenModel, createdAt: at(60000).toISOString(), expiresAt: at(86460000).toISOString()
    });
    expectCommitted();
    expect(statements()[1]).toMatch(/FROM users WHERE id = \$1 FOR UPDATE$/);
    expect(statements()[2]).toContain("created_at > $2::timestamptz - INTERVAL '24 hours'");
    expect(client.query.mock.calls[2][1]).toEqual([user.id, at(60000).toISOString()]);
    expect(statements()[3]).toMatch(/^INSERT INTO email_confirmation_tokens/);
    expect(statements().some((sql) => /^UPDATE email_confirmation_tokens/.test(sql))).toBe(false);
  });

  it.each([
    { policy: "cooldown", before: 59999, after: 60000, count: "1", last: 0 },
    { policy: "ventana móvil de 24 horas", before: 86399999, after: 86400000, count: "4", last: 240000 }
  ])("calcula $policy con la hora posterior a esperar el bloqueo de usuario", async ({ before, after, count, last }) => {
    let current = at(before);
    const clock = vi.fn(() => current);
    responses([]);
    const blocked = pauseNextQuery();
    const emittedRow = { ...tokenRow, created_at: at(after), expires_at: at(after + 86400000) };
    responses([{ issued_count: count, last_created_at: at(last) }], [emittedRow], []);

    const pending = repository.issueConfirmationToken(user.id, token, clock);
    await blocked.waiting;
    expect(clock).not.toHaveBeenCalled();
    current = at(after);
    blocked.release([userRow]);

    expect(await pending).toMatchObject({ createdAt: at(after).toISOString() });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[2][1]).toEqual([user.id, at(after).toISOString()]);
    expect(client.query.mock.calls[3][1]).toEqual([
      token.id, user.id, token.tokenHash, at(after).toISOString(), at(after + 86400000).toISOString()
    ]);
    expectCommitted();
  });

  it.each(["usuario", "token"])("rechaza un token que caduca mientras espera el bloqueo de %s", async (lock) => {
    let current = at(86399999);
    const clock = vi.fn(() => current);
    responses([], [{ user_id: user.id }]);
    if (lock === "token") responses([userRow]);
    const blocked = pauseNextQuery();
    if (lock === "usuario") responses([tokenRow]);
    responses([]);

    const pending = repository.confirmWithToken(token.tokenHash, clock);
    await blocked.waiting;
    expect(clock).not.toHaveBeenCalled();
    current = at(86400000);
    blocked.release(lock === "usuario" ? [userRow] : [tokenRow]);

    expect(await pending).toBeNull();
    expect(clock).toHaveBeenCalledTimes(1);
    expect(statements().some((sql) => /^UPDATE/.test(sql))).toBe(false);
    expectCommitted();
  });

  it("el reloj por defecto lee la hora real después del bloqueo del token", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(86399999));
      responses([], [{ user_id: user.id }], [userRow]);
      const blocked = pauseNextQuery();
      responses([]);
      const pending = repository.confirmWithToken(token.tokenHash);
      await blocked.waiting;
      vi.setSystemTime(at(86400000));
      blocked.release([tokenRow]);
      expect(await pending).toBeNull();
      expect(statements().some((sql) => /^UPDATE/.test(sql))).toBe(false);
      expectCommitted();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["issueConfirmationToken", "confirmWithToken"])("establece READ COMMITTED en %s usando el mismo cliente", async (operation) => {
    if (operation === "issueConfirmationToken") {
      responses([], [], []);
      expect(await repository.issueConfirmationToken(user.id, token, () => at())).toBeNull();
    } else {
      responses([], [], []);
      expect(await repository.confirmWithToken(token.tokenHash, () => at())).toBeNull();
    }
    expect(client.query.mock.calls[0]).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED"]);
    expectCommitted();
  });

  it.each(["issueConfirmationToken", "confirmWithToken"])("no acepta una fecha capturada en lugar de un reloj para %s", async (operation) => {
    responses([]);
    if (operation === "issueConfirmationToken") responses([userRow]);
    else responses([{ user_id: user.id }], [userRow], [tokenRow]);
    responses([]);
    const pending = operation === "issueConfirmationToken"
      ? repository.issueConfirmationToken(user.id, token, at())
      : repository.confirmWithToken(token.tokenHash, at());
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(statements().some((sql) => /^(INSERT|UPDATE)/.test(sql))).toBe(false);
    expect(statements().at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("revierte y libera el cliente si falla el inicio explícito en READ COMMITTED", async () => {
    const failure = new Error("Inicio de transacción no disponible");
    responses(failure, []);
    await expect(repository.issueConfirmationToken(user.id, token, () => at())).rejects.toBe(failure);
    expect(statements()).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    ["cooldown", "1", START, 59999],
    ["límite diario", "5", START, 60000]
  ])("no inserta ni revoca tokens ante %s", async (_, count, last, offset) => {
    responses([], [userRow], [{ issued_count: count, last_created_at: last }], []);
    expect(await repository.issueConfirmationToken(user.id, token, () => at(offset))).toBeNull();
    expectCommitted();
    expect(statements().some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });

  it.each([
    { state: "inexistente", rows: [] },
    { state: "confirmada", rows: [{ confirmed: true, deleted_at: null }] },
    { state: "eliminada", rows: [{ confirmed: false, deleted_at: at() }] }
  ])(
    "no emite para cuenta $state", async ({ rows }) => {
      responses([], rows, []);
      expect(await repository.issueConfirmationToken(user.id, token, () => at(60000))).toBeNull();
      expectCommitted();
      expect(statements()).toHaveLength(3);
    }
  );

  it("revierte un hash duplicado al emitir sin alterar los tokens anteriores", async () => {
    const duplicate = Object.assign(new Error("Hash duplicado"), { code: "23505" });
    responses([], [userRow], [{ issued_count: "1", last_created_at: at() }], duplicate, []);
    await expect(repository.issueConfirmationToken(user.id, token, () => at(60000)))
      .rejects.toMatchObject({ code: "23505" });
    expect(statements().at(-1)).toBe("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("consulta por hash parametrizado y normaliza timestamps", async () => {
    pool.query.mockResolvedValue({ rows: [tokenRow] });
    expect(await repository.findConfirmationTokenByHash(token.tokenHash.toUpperCase())).toEqual(tokenModel);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE token_hash = $1"), [token.tokenHash]
    );
    expect(pool.connect).not.toHaveBeenCalled();
    pool.query.mockResolvedValue({ rows: [] });
    expect(await repository.findConfirmationTokenByHash(token.tokenHash)).toBeNull();
  });

  it("incluye vigencia, uso, revocación y estado de cuenta en la consulta de validación", async () => {
    pool.query.mockResolvedValue({ rows: [tokenRow] });
    expect(await repository.findValidConfirmationToken(token.tokenHash, at())).toEqual(tokenModel);
    const [sql, params] = pool.query.mock.calls[0];
    expect(params).toEqual([token.tokenHash, START]);
    expect(sql).toContain("token.created_at <= $2 AND token.expires_at > $2");
    expect(sql).toContain("token.used_at IS NULL AND token.revoked_at IS NULL");
    expect(sql).toContain("account.confirmed = FALSE AND account.deleted_at IS NULL");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("confirma, consume y revoca los demás tokens en una única transacción", async () => {
    responses([], [{ user_id: user.id }], [userRow], [tokenRow],
      [{ ...userRow, confirmed: true, updated_at: at(1000) }], [], [], []);
    expect(await repository.confirmWithToken(token.tokenHash, () => at(1000))).toEqual({
      ...user, confirmed: true, updatedAt: at(1000).toISOString()
    });
    expectCommitted();
    expect(statements()[2]).toMatch(/FROM users WHERE id = \$1 FOR UPDATE$/);
    expect(statements()[3]).toContain("WHERE token_hash = $1 AND user_id = $2 FOR UPDATE");
    expect(statements()[4]).toContain("confirmed = FALSE AND deleted_at IS NULL");
    expect(client.query.mock.calls[5][1]).toEqual([token.id, at(1000).toISOString()]);
    expect(statements()[6]).toContain("WHERE user_id = $1 AND id <> $3 AND used_at IS NULL AND revoked_at IS NULL");
    expect(client.query.mock.calls[6][1]).toEqual([user.id, at(1000).toISOString(), token.id]);
  });

  it.each(["confirmación", "consumo", "revocación", "commit"])("solicita rollback si falla %s", async (step) => {
    const failure = new Error("Fallo transaccional simulado");
    const writes = [[{ ...userRow, confirmed: true }], [], [], []];
    const index = ["confirmación", "consumo", "revocación", "commit"].indexOf(step);
    responses([], [{ user_id: user.id }], [userRow], [tokenRow], ...writes.slice(0, index), failure, []);
    await expect(repository.confirmWithToken(token.tokenHash, () => at(1000))).rejects.toBe(failure);
    expect(statements().at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    ["caducado", { expires_at: at(1000) }],
    ["utilizado", { used_at: at(500) }],
    ["revocado", { revoked_at: at(500) }],
    ["futuro", { created_at: at(2000) }]
  ])("no modifica la cuenta con token %s", async (_, changes) => {
    responses([], [{ user_id: user.id }], [userRow], [{ ...tokenRow, ...changes }], []);
    expect(await repository.confirmWithToken(token.tokenHash, () => at(1000))).toBeNull();
    expectCommitted();
    expect(statements().some((sql) => /^UPDATE/.test(sql))).toBe(false);
  });

  it.each([
    { state: "inexistente", rows: [] },
    { state: "confirmada", rows: [{ ...userRow, confirmed: true }] },
    { state: "eliminada", rows: [{ ...userRow, deleted_at: at() }] }
  ])(
    "no confirma cuentas $state", async ({ rows }) => {
      responses([], [{ user_id: user.id }], rows, []);
      expect(await repository.confirmWithToken(token.tokenHash, () => at(1000))).toBeNull();
      expectCommitted();
      expect(statements().some((sql) => /^UPDATE/.test(sql))).toBe(false);
    }
  );

  it("no modifica cuentas ante hash inexistente", async () => {
    responses([], [], []);
    expect(await repository.confirmWithToken(token.tokenHash, () => at())).toBeNull();
    expectCommitted();
    expect(statements()).toHaveLength(3);
  });

  it("no consulta PostgreSQL con hashes malformados", async () => {
    expect(await repository.findConfirmationTokenByHash("inválido")).toBeNull();
    expect(await repository.findValidConfirmationToken(null, at())).toBeNull();
    expect(await repository.confirmWithToken({}, () => at())).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("emite DDL aditivo con restricciones e índices, sin ejecutar un motor SQL", async () => {
    await initializeDatabase(pool);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS email_confirmation_tokens");
    expect(sql).toContain("user_id UUID NOT NULL REFERENCES users(id)");
    expect(sql).toContain("token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(sql).toContain("CHECK (expires_at = created_at + INTERVAL '24 hours')");
    expect(sql).toContain("ON email_confirmation_tokens (user_id, created_at DESC)");
    expect(sql).toContain("ON email_confirmation_tokens (expires_at)");
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
  });
});
