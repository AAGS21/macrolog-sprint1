import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryUserRepository } from "../src/repositories/inMemoryUser.repository.js";

const START = "2026-11-17T10:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const at = (offset = 0) => new Date(Date.parse(START) + offset);
const newToken = (changes = {}) => ({
  id: randomUUID(), tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), ...changes
});
const newUser = (changes = {}) => ({
  id: randomUUID(), email: `${randomUUID()}@example.test`, passwordHash: "fixture-password-hash",
  role: "user", confirmed: false, deletedAt: null, createdAt: START, updatedAt: START, ...changes
});

describe("Confirmación de cuentas: repositorio en memoria", () => {
  let repository;
  let user;
  let token;
  beforeEach(() => {
    repository = new InMemoryUserRepository();
    user = newUser();
    token = newToken();
  });

  it("crea cuenta pendiente y primer token asociado, solo con hash y vigencia de 24 horas", async () => {
    const result = await repository.createPendingWithToken(user, {
      ...token, originalToken: "no-debe-persistirse", expiresAt: "2099-01-01", userId: randomUUID()
    }, at());
    expect(result.user).toEqual(user);
    expect(result.token).toEqual({
      ...token, userId: user.id, createdAt: START, expiresAt: at(DAY).toISOString(),
      usedAt: null, revokedAt: null
    });
    expect(await repository.findById(user.id)).toEqual(user);
    expect(await repository.findConfirmationTokenByHash(token.tokenHash)).toEqual(result.token);
    expect(result.token).not.toHaveProperty("originalToken");
  });

  it("devuelve copias sin exponer sus objetos almacenados", async () => {
    const result = await repository.createPendingWithToken(user, token, START);
    result.user.confirmed = true;
    result.token.usedAt = START;
    const found = await repository.findConfirmationTokenByHash(token.tokenHash);
    found.revokedAt = START;
    expect((await repository.findById(user.id)).confirmed).toBe(false);
    expect((await repository.findValidConfirmationToken(token.tokenHash, at())).usedAt).toBeNull();
  });

  it.each(["constructor", "create"])("normaliza UUID al ingresar por %s y permite buscar y actualizar con cualquier caja", async (entry) => {
    const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const uppercaseUser = { ...user, id: id.toUpperCase() };
    if (entry === "constructor") repository = new InMemoryUserRepository([uppercaseUser]);
    else expect((await repository.create(uppercaseUser)).id).toBe(id);

    expect(await repository.findById(id)).toEqual({ ...user, id });
    expect(await repository.findById(id.toUpperCase())).toEqual({ ...user, id });
    expect((await repository.update(id.toUpperCase(), { role: "admin" })).id).toBe(id);
    expect((await repository.findById(id)).role).toBe("admin");
    await expect(repository.create(newUser({ id }))).rejects.toMatchObject({ code: "23505" });
    expect(await repository.findAll()).toHaveLength(1);
  });

  it.each([false, true])("rechaza un segundo usuario con el mismo UUID cambiando su caja, mayúsculas iniciales: %s", async (uppercaseFirst) => {
    const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const firstId = uppercaseFirst ? id.toUpperCase() : id;
    const secondId = uppercaseFirst ? id : id.toUpperCase();
    const created = await repository.createPendingWithToken({ ...user, id: firstId }, token, at());
    expect(created.user.id).toBe(id);
    expect(created.token.userId).toBe(id);
    await expect(repository.createPendingWithToken(newUser({ id: secondId }), newToken(), at()))
      .rejects.toMatchObject({ code: "23505", constraint: "users_pkey" });
    expect(await repository.findAll()).toHaveLength(1);
    expect(repository.confirmationTokens.size).toBe(1);
    expect(await repository.findById(secondId)).toEqual(created.user);
  });

  it("comparte propietario, cooldown y cuota entre las variantes del UUID y revoca sus tokens al confirmar", async () => {
    const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    await repository.createPendingWithToken({ ...user, id: id.toUpperCase() }, token, at());
    const second = await repository.issueConfirmationToken(id, newToken(), () => at(60000));
    expect(second.userId).toBe(id);
    expect(await repository.issueConfirmationToken(id.toUpperCase(), newToken(), () => at(60000))).toBeNull();
    for (let i = 2; i < 5; i++) {
      expect(await repository.issueConfirmationToken(id.toUpperCase(), newToken(), () => at(i * 60000)))
        .toMatchObject({ userId: id });
    }
    expect(await repository.issueConfirmationToken(id, newToken(), () => at(300000))).toBeNull();
    expect(await repository.findValidConfirmationToken(second.tokenHash, at(300000))).not.toBeNull();
    expect(await repository.confirmWithToken(token.tokenHash, () => at(300000)))
      .toMatchObject({ id, confirmed: true });
    expect((await repository.findConfirmationTokenByHash(second.tokenHash)).revokedAt).toBe(at(300000).toISOString());
    expect(await repository.findById(id.toUpperCase())).toEqual(await repository.findById(id));
  });

  it.each(["hash", "id", "email", "userId"])("revierte el alta completa ante duplicado de %s", async (duplicate) => {
    await repository.createPendingWithToken(user, token, at());
    const otherUser = newUser();
    const otherToken = newToken();
    if (duplicate === "hash") otherToken.tokenHash = token.tokenHash.toUpperCase();
    if (duplicate === "id") otherToken.id = token.id;
    if (duplicate === "email") otherUser.email = user.email;
    if (duplicate === "userId") otherUser.id = user.id;
    await expect(repository.createPendingWithToken(otherUser, otherToken, at()))
      .rejects.toMatchObject({ code: "23505" });
    expect(await repository.findAll()).toEqual([user]);
    expect(repository.confirmationTokens.size).toBe(1);
    expect((await repository.findConfirmationTokenByHash(token.tokenHash)).userId).toBe(user.id);
  });

  it.each([null, {}, "incorrecto", "g".repeat(64)])("rechaza un hash malformado sin alterar cuentas: %j", async (hash) => {
    await expect(repository.createPendingWithToken(user, newToken({ tokenHash: hash }), at()))
      .rejects.toBeInstanceOf(TypeError);
    expect(await repository.findAll()).toEqual([]);
    expect(await repository.findConfirmationTokenByHash(hash)).toBeNull();
    expect(await repository.findValidConfirmationToken(hash, at())).toBeNull();
    expect(await repository.confirmWithToken(hash, () => at())).toBeNull();
  });

  it.each([undefined, null, "no-es-fecha", new Date(NaN)])("exige una fecha actual válida: %s", async (now) => {
    await expect(repository.createPendingWithToken(user, token, now)).rejects.toBeInstanceOf(TypeError);
    expect(await repository.findAll()).toEqual([]);
  });

  it("caduca exactamente a las 24 horas y no confirma antes de su emisión", async () => {
    await repository.createPendingWithToken(user, token, at());
    expect(await repository.findValidConfirmationToken(token.tokenHash, at(-1))).toBeNull();
    expect(await repository.confirmWithToken(token.tokenHash, () => at(-1))).toBeNull();
    expect(await repository.findValidConfirmationToken(token.tokenHash, at(DAY - 1))).not.toBeNull();
    expect(await repository.findValidConfirmationToken(token.tokenHash, at(DAY))).toBeNull();
    expect(await repository.confirmWithToken(token.tokenHash, () => at(DAY))).toBeNull();
    expect((await repository.findById(user.id)).confirmed).toBe(false);
    expect((await repository.findConfirmationTokenByHash(token.tokenHash)).usedAt).toBeNull();
  });

  it("confirma y consume el token una sola vez", async () => {
    await repository.createPendingWithToken(user, token, at());
    const confirmed = await repository.confirmWithToken(token.tokenHash.toUpperCase(), () => at(1000));
    expect(confirmed).toEqual({ ...user, confirmed: true, updatedAt: at(1000).toISOString() });
    const consumed = await repository.findConfirmationTokenByHash(token.tokenHash);
    expect(consumed.usedAt).toBe(at(1000).toISOString());
    expect(consumed.revokedAt).toBeNull();
    expect(await repository.confirmWithToken(token.tokenHash, () => at(2000))).toBeNull();
    expect(await repository.findValidConfirmationToken(token.tokenHash, at(2000))).toBeNull();
  });

  it("mantiene enlaces anteriores y revoca los restantes al confirmar con el primero", async () => {
    await repository.createPendingWithToken(user, token, at());
    const second = await repository.issueConfirmationToken(user.id, newToken(), () => at(60000));
    expect(await repository.findValidConfirmationToken(token.tokenHash, at(61000))).not.toBeNull();
    expect(await repository.findValidConfirmationToken(second.tokenHash, at(61000))).not.toBeNull();
    expect(await repository.confirmWithToken(token.tokenHash, () => at(61000))).not.toBeNull();
    expect((await repository.findConfirmationTokenByHash(second.tokenHash)).revokedAt).toBe(at(61000).toISOString());
    expect(await repository.confirmWithToken(second.tokenHash, () => at(62000))).toBeNull();
  });

  it("puede confirmar con un enlace nuevo después de caducar el anterior", async () => {
    await repository.createPendingWithToken(user, token, at());
    const second = await repository.issueConfirmationToken(user.id, newToken(), () => at(60000));
    expect(await repository.findValidConfirmationToken(token.tokenHash, at(DAY))).toBeNull();
    expect(await repository.confirmWithToken(second.tokenHash, () => at(DAY))).not.toBeNull();
    expect((await repository.findConfirmationTokenByHash(token.tokenHash)).revokedAt).toBe(at(DAY).toISOString());
  });

  it("no revoca tokens de otra cuenta", async () => {
    await repository.createPendingWithToken(user, token, at());
    const otherUser = newUser();
    const other = await repository.createPendingWithToken(otherUser, newToken(), at());
    await repository.confirmWithToken(token.tokenHash, () => at(1000));
    expect(await repository.findValidConfirmationToken(other.token.tokenHash, at(1000))).toEqual(other.token);
  });

  it("respeta el cooldown hasta el milisegundo anterior a los 60 segundos", async () => {
    await repository.createPendingWithToken(user, token, at());
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(59999))).toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(60000))).not.toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(119999))).toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(120000))).not.toBeNull();
  });

  it("cuenta el primer token dentro de cinco emisiones por ventana móvil de 24 horas", async () => {
    await repository.createPendingWithToken(user, token, at());
    for (let i = 1; i < 5; i++) {
      expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(i * 60000))).not.toBeNull();
    }
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(300000))).toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(DAY - 1))).toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(DAY))).not.toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(DAY + 59999))).toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(DAY + 60000))).not.toBeNull();
  });

  it("un hash duplicado no consume una emisión adicional", async () => {
    await repository.createPendingWithToken(user, token, at());
    await expect(repository.issueConfirmationToken(user.id, newToken({ tokenHash: token.tokenHash }), () => at(60000)))
      .rejects.toMatchObject({ code: "23505" });
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(60000))).not.toBeNull();
    expect(repository.confirmationTokens.size).toBe(2);
  });

  it.each(["deleted", "confirmed", "missing"])("rechaza consultas válidas, emisión y confirmación de cuenta %s", async (state) => {
    await repository.createPendingWithToken(user, token, at());
    if (state === "deleted") await repository.update(user.id, { deletedAt: START });
    if (state === "confirmed") await repository.update(user.id, { confirmed: true });
    if (state === "missing") repository.users = [];
    expect(await repository.findValidConfirmationToken(token.tokenHash, at(60000))).toBeNull();
    expect(await repository.issueConfirmationToken(user.id, newToken(), () => at(60000))).toBeNull();
    expect(await repository.confirmWithToken(token.tokenHash, () => at(60000))).toBeNull();
    expect((await repository.findConfirmationTokenByHash(token.tokenHash)).usedAt).toBeNull();
  });

  it.each([{ confirmed: true }, { deletedAt: START }])("no crea un alta pendiente con estado incompatible: %j", async (changes) => {
    await expect(repository.createPendingWithToken({ ...user, ...changes }, token, at()))
      .rejects.toBeInstanceOf(TypeError);
    expect(await repository.findAll()).toEqual([]);
  });

  it("serializa las operaciones simultáneas en memoria sin intercalar escrituras", async () => {
    await repository.createPendingWithToken(user, token, at());
    const issued = await Promise.all([
      repository.issueConfirmationToken(user.id, newToken(), () => at(60000)),
      repository.issueConfirmationToken(user.id, newToken(), () => at(60000))
    ]);
    expect(issued.filter(Boolean)).toHaveLength(1);
    const confirmed = await Promise.all([
      repository.confirmWithToken(token.tokenHash, () => at(61000)),
      repository.confirmWithToken(issued.find(Boolean).tokenHash, () => at(61000))
    ]);
    expect(confirmed.filter(Boolean)).toHaveLength(1);
  });
});
