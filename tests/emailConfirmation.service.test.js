import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailConfirmationService } from "../src/services/emailConfirmation.service.js";
import { InMemoryUserRepository } from "../src/repositories/inMemoryUser.repository.js";
import { logger } from "../src/utils/logger.js";

const START = new Date("2026-11-17T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const hash = (token) => createHash("sha256").update(token).digest("hex");
const rawTokenFrom = (message) => new URLSearchParams(new URL(message.confirmationUrl).hash.slice(1)).get("token");

describe("EmailConfirmationService", () => {
  let repository;
  let sender;
  let service;
  let account;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    repository = new InMemoryUserRepository();
    sender = { sendConfirmationEmail: vi.fn().mockResolvedValue("test-message-id") };
    service = new EmailConfirmationService({
      userRepository: repository, brevoEmailService: sender, appBaseUrl: "https://macrolog.example/base"
    });
    account = {
      id: randomUUID(), email: "persona@example.test", passwordHash: "test-password-hash",
      role: "user", confirmed: false, deletedAt: null
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function register() {
    const user = await service.registerPendingAccount(account);
    return { user, rawToken: rawTokenFrom(sender.sendConfirmationEmail.mock.calls[0][0]) };
  }

  it("crea usuario y primer token juntos, con UUID y SHA-256, sin persistir ni devolver el original", async () => {
    const create = vi.spyOn(repository, "createPendingWithToken");
    const user = await service.registerPendingAccount(account);
    const message = sender.sendConfirmationEmail.mock.calls[0][0];
    const raw = rawTokenFrom(message);
    const stored = await repository.findConfirmationTokenByHash(hash(raw));
    expect(Buffer.from(raw, "base64url")).toHaveLength(32);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(create).toHaveBeenCalledExactlyOnceWith(account, {
      id: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/), tokenHash: hash(raw)
    }, START);
    expect(stored).toMatchObject({ userId: user.id, tokenHash: hash(raw), expiresAt: new Date(+START + DAY).toISOString() });
    expect(user).toEqual(await repository.findById(account.id));
    expect(JSON.stringify({ user, users: repository.users, tokens: [...repository.confirmationTokens.values()] })).not.toContain(raw);
    expect(message.to).toBe(account.email);
    const link = new URL(message.confirmationUrl);
    expect(link.origin).toBe("https://macrolog.example");
    expect(link.pathname).toBe("/confirm.html");
    expect(link.search).toBe("");
    expect(link.hash).toBe(`#token=${raw}`);
  });

  it("espera la resolución de la transacción antes de enviar", async () => {
    const original = repository.createPendingWithToken.bind(repository);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    vi.spyOn(repository, "createPendingWithToken").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const registering = service.registerPendingAccount(account);
    expect(sender.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(repository.users).toHaveLength(0);
    release();
    await registering;
    expect(sender.sendConfirmationEmail).toHaveBeenCalledOnce();
    expect(repository.users).toHaveLength(1);
  });

  it("no envía ni transforma el fallo si falla la transacción de creación", async () => {
    const failure = new Error("Fallo transaccional de prueba");
    vi.spyOn(repository, "createPendingWithToken").mockRejectedValue(failure);
    await expect(service.registerPendingAccount(account)).rejects.toBe(failure);
    expect(sender.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(repository.users).toHaveLength(0);
    expect(repository.confirmationTokens.size).toBe(0);
  });

  it("devuelve la cuenta pendiente ante fallo de Brevo, conserva el token y registra solo el identificador", async () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    sender.sendConfirmationEmail.mockImplementation(async (message) => {
      throw new Error(`unit-test-api-key ${message.to} ${message.confirmationUrl}`);
    });
    const user = await service.registerPendingAccount(account);
    const raw = rawTokenFrom(sender.sendConfirmationEmail.mock.calls[0][0]);
    expect(user).toMatchObject({ id: account.id, confirmed: false });
    expect(log).toHaveBeenCalledExactlyOnceWith("email.confirmation_delivery_failed", { userId: account.id });
    for (const secret of ["unit-test-api-key", raw, account.email, "https://macrolog.example"]) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    }
    expect((await repository.findById(account.id)).confirmed).toBe(false);
    expect(await repository.findConfirmationTokenByHash(hash(raw))).not.toBeNull();
  });

  it("confirma directamente con hash y reloj evaluable al adquirir los bloqueos", async () => {
    const { rawToken } = await register();
    const find = vi.spyOn(repository, "findConfirmationTokenByHash");
    const valid = vi.spyOn(repository, "findValidConfirmationToken");
    const original = repository.confirmWithToken.bind(repository);
    const confirm = vi.spyOn(repository, "confirmWithToken").mockImplementation((tokenHash, clock) => {
      vi.setSystemTime(+START + 1000);
      expect(clock()).toEqual(new Date(+START + 1000));
      return original(tokenHash, clock);
    });
    expect(await service.confirmAccount(rawToken)).toMatchObject({ id: account.id, confirmed: true });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(hash(rawToken), expect.any(Function));
    expect(find).not.toHaveBeenCalled();
    expect(valid).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, 42, {}, [], "", "bad", "a".repeat(42), "a".repeat(44),
    "+".repeat(43), "a".repeat(42) + "=", "A".repeat(42) + "B", " A".repeat(22)
  ])("rechaza el formato no canónico sin consultar el repositorio: %j", async (token) => {
    const confirm = vi.spyOn(repository, "confirmWithToken");
    expect(await service.confirmAccount(token)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rechaza un token bien formado pero desconocido", async () => {
    expect(await service.confirmAccount(randomBytes(32).toString("base64url"))).toBeNull();
  });

  it.each(["expired", "used", "revoked", "deleted", "confirmed"])("rechaza un token de estado %s", async (state) => {
    const { rawToken } = await register();
    const token = repository.confirmationTokens.get(hash(rawToken));
    if (state === "expired") vi.setSystemTime(+START + DAY);
    if (state === "used") token.usedAt = START.toISOString();
    if (state === "revoked") token.revokedAt = START.toISOString();
    if (state === "deleted") await repository.update(account.id, { deletedAt: START.toISOString() });
    if (state === "confirmed") await repository.update(account.id, { confirmed: true });
    expect(await service.confirmAccount(rawToken)).toBeNull();
  });

  it("solo una confirmación simultánea prospera usando el repositorio en memoria", async () => {
    const { rawToken } = await register();
    const results = await Promise.all([service.confirmAccount(rawToken), service.confirmAccount(rawToken)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await service.confirmAccount(rawToken)).toBeNull();
  });

  it("conserva el token anterior al reenviar y revoca el resto cuando se confirma con él", async () => {
    const { rawToken } = await register();
    vi.setSystemTime(+START + 60000);
    await service.resendConfirmation(" PERSONA@Example.Test ");
    const secondRaw = rawTokenFrom(sender.sendConfirmationEmail.mock.calls[1][0]);
    expect(secondRaw).not.toBe(rawToken);
    expect(await repository.findValidConfirmationToken(hash(rawToken), new Date())).not.toBeNull();
    expect(await service.confirmAccount(rawToken)).toMatchObject({ confirmed: true });
    expect(await repository.findConfirmationTokenByHash(hash(rawToken))).toMatchObject({ usedAt: new Date().toISOString(), revokedAt: null });
    expect(await repository.findConfirmationTokenByHash(hash(secondRaw))).toMatchObject({ usedAt: null, revokedAt: new Date().toISOString() });
    expect(await service.confirmAccount(secondRaw)).toBeNull();
  });

  it("respeta el cooldown inicial: 59.999 ms rechazados y 60.000 ms aceptados", async () => {
    await register();
    vi.setSystemTime(+START + 59999);
    expect(await service.resendConfirmation(account.email)).toBeUndefined();
    expect(sender.sendConfirmationEmail).toHaveBeenCalledTimes(1);
    vi.setSystemTime(+START + 60000);
    expect(await service.resendConfirmation(account.email)).toBeUndefined();
    expect(sender.sendConfirmationEmail).toHaveBeenCalledTimes(2);
    expect(repository.confirmationTokens.size).toBe(2);
  });

  it("aplica cinco emisiones incluida la inicial y permite emitir cuando sale de la ventana móvil", async () => {
    await register();
    for (let minute = 1; minute <= 5; minute++) {
      vi.setSystemTime(+START + minute * 60000);
      await service.resendConfirmation(account.email);
    }
    expect(sender.sendConfirmationEmail).toHaveBeenCalledTimes(5);
    expect(repository.confirmationTokens.size).toBe(5);
    vi.setSystemTime(+START + DAY);
    await service.resendConfirmation(account.email);
    expect(sender.sendConfirmationEmail).toHaveBeenCalledTimes(6);
    expect(repository.confirmationTokens.size).toBe(6);
  });

  it.each(["missing", "confirmed", "deleted", "invalid"])("no emite ni envía para %s", async (state) => {
    if (state !== "missing" && state !== "invalid") {
      await register();
      await repository.update(account.id, state === "confirmed" ? { confirmed: true } : { deletedAt: START.toISOString() });
    }
    sender.sendConfirmationEmail.mockClear();
    const issue = vi.spyOn(repository, "issueConfirmationToken");
    expect(await service.resendConfirmation(state === "invalid" ? "bad-email" : account.email)).toBeUndefined();
    expect(issue).not.toHaveBeenCalled();
    expect(sender.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it("espera la emisión, pasa un reloj y no envía cuando el repositorio la rechaza", async () => {
    await register();
    sender.sendConfirmationEmail.mockClear();
    const issue = vi.spyOn(repository, "issueConfirmationToken").mockImplementation(async (userId, token, clock) => {
      vi.setSystemTime(+START + 60000);
      expect(clock()).toEqual(new Date(+START + 60000));
      expect(userId).toBe(account.id);
      expect(token).toEqual({ id: expect.any(String), tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      return null;
    });
    await service.resendConfirmation(account.email);
    expect(issue).toHaveBeenCalledOnce();
    expect(sender.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it("oculta el fallo de reenvío y conserva el nuevo token computando para el cooldown", async () => {
    await register();
    vi.setSystemTime(+START + 60000);
    sender.sendConfirmationEmail.mockRejectedValue(new Error("unit-test-provider-secret"));
    expect(await service.resendConfirmation(account.email)).toBeUndefined();
    expect(repository.confirmationTokens.size).toBe(2);
    await service.resendConfirmation(account.email);
    expect(sender.sendConfirmationEmail).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined, null, 42, "", "https://", "/relative", "//example.test", "https:example.test",
    "javascript:alert(1)", "data:text/html,test", "https://user:password@example.test",
    "https://example.test?source=registration", "https://example.test#fragment", "https://example.test?", "https://example.test#",
    "https://example.test/a b", "https://example.test\n", "https:\\example.test",
    "http://example.test", "http://localhost:3000", "http://127.0.0.1:3000"
  ])("rechaza APP_BASE_URL no válida sin revelar su contenido: %j", (appBaseUrl) => {
    let error;
    try { new EmailConfirmationService({ userRepository: repository, brevoEmailService: sender, appBaseUrl }); }
    catch (failure) { error = failure; }
    expect(error).toMatchObject({ statusCode: 500, code: "EMAIL_CONFIRMATION_CONFIG_ERROR" });
    expect(error.message).toBe("La configuración de confirmación de cuentas no es válida");
  });

  it("solo permite HTTP localhost en desarrollo y genera el enlace con fragmento", async () => {
    service = new EmailConfirmationService({
      userRepository: repository, brevoEmailService: sender, appBaseUrl: "http://localhost:3000", isDevelopment: true
    });
    await register();
    const url = new URL(sender.sendConfirmationEmail.mock.calls[0][0].confirmationUrl);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/confirm.html");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
    expect(() => new EmailConfirmationService({
      userRepository: repository, brevoEmailService: sender, appBaseUrl: "http://example.test", isDevelopment: true
    })).toThrow();
  });
});
