import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { InMemoryUserRepository } from "../src/repositories/inMemoryUser.repository.js";
import { UserService } from "../src/services/user.service.js";
import { EmailConfirmationService } from "../src/services/emailConfirmation.service.js";

const ADMIN_PASSWORD = "Admin1234";
const USER_PASSWORD = "Usuario1234";

describe("UserService", () => {
  let repository;
  let service;
  let admin;

  beforeEach(async () => {
    repository = new InMemoryUserRepository();
    service = new UserService(repository, {
      passwordRounds: 4,
      requireEmailConfirmation: false
    });

    admin = await service.createAdmin({
      email: "admin@macrolog.es",
      password: ADMIN_PASSWORD
    });
  });

  it("registra un usuario normalizando el email y protegiendo la contraseña", async () => {
    const user = await service.register({
      email: "  PERSONA@Example.com ",
      password: USER_PASSWORD
    });

    const storedUser = await repository.findById(user.id);

    expect(user.email).toBe("persona@example.com");
    expect(user.role).toBe("user");
    expect(user.active).toBe(true);
    expect(storedUser.passwordHash).not.toBe(USER_PASSWORD);
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rechaza el registro de un email existente", async () => {
    await service.register({
      email: "persona@example.com",
      password: USER_PASSWORD
    });

    await expect(
      service.register({
        email: "PERSONA@example.com",
        password: USER_PASSWORD
      })
    ).rejects.toMatchObject({
      code: "EMAIL_ALREADY_EXISTS",
      statusCode: 409
    });
  });

  it("rechaza las contraseñas de menos de ocho caracteres", async () => {
    await expect(
      service.register({
        email: "persona@example.com",
        password: "123"
      })
    ).rejects.toMatchObject({
      code: "WEAK_PASSWORD",
      statusCode: 400
    });
  });

  it("impide iniciar sesión con una cuenta pendiente", async () => {
    const pendingService = new UserService(repository, {
      passwordRounds: 4,
      requireEmailConfirmation: true,
      emailConfirmationService: new EmailConfirmationService({
        userRepository: repository,
        brevoEmailService: { async sendConfirmationEmail() { return "test-message-id"; } },
        appBaseUrl: "https://macrolog.example"
      })
    });

    await pendingService.register({
      email: "pendiente@example.com",
      password: USER_PASSWORD
    });

    await expect(
      pendingService.authenticate({
        email: "pendiente@example.com",
        password: USER_PASSWORD
      })
    ).rejects.toMatchObject({
      code: "ACCOUNT_PENDING",
      statusCode: 403
    });
  });

  it("permite iniciar sesión con credenciales válidas", async () => {
    await service.register({
      email: "persona@example.com",
      password: USER_PASSWORD
    });

    const user = await service.authenticate({
      email: "persona@example.com",
      password: USER_PASSWORD
    });

    expect(user.email).toBe("persona@example.com");
    expect(user.active).toBe(true);
  });

  it("permite al administrador listar usuarios sin mostrar hashes", async () => {
    await service.register({
      email: "persona@example.com",
      password: USER_PASSWORD
    });

    const users = await service.listUsers(admin.id);

    expect(users).toHaveLength(2);
    expect(users[0]).not.toHaveProperty("passwordHash");
    expect(users[1]).not.toHaveProperty("passwordHash");
  });

  it("impide que un usuario normal liste usuarios", async () => {
    const user = await service.register({
      email: "persona@example.com",
      password: USER_PASSWORD
    });

    await expect(service.listUsers(user.id)).rejects.toMatchObject({
      code: "ADMIN_REQUIRED",
      statusCode: 403
    });
  });

  it("impide que un usuario normal elimine a otro", async () => {
    const firstUser = await service.register({
      email: "primero@example.com",
      password: USER_PASSWORD
    });

    const secondUser = await service.register({
      email: "segundo@example.com",
      password: USER_PASSWORD
    });

    await expect(
      service.deleteUser(firstUser.id, secondUser.id)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403
    });
  });

  it("permite a un usuario eliminar su propia cuenta", async () => {
    const user = await service.register({
      email: "persona@example.com",
      password: USER_PASSWORD
    });

    const deletedUser = await service.deleteUser(user.id, user.id);

    expect(deletedUser.status).toBe("deleted");
    expect(deletedUser.active).toBe(false);
  });

  it("permite al administrador consultar y eliminar usuarios", async () => {
    const user = await service.register({
      email: "persona@example.com",
      password: USER_PASSWORD
    });

    expect(await service.isUserActive(admin.id, user.id)).toBe(true);

    await service.deleteUser(admin.id, user.id);

    expect(await service.isUserActive(admin.id, user.id)).toBe(false);
  });
});

describe("UserService integrado con RF-02", () => {
  let repository;
  let service;
  let sender;
  let confirmation;

  beforeEach(() => {
    repository = new InMemoryUserRepository();
    sender = { sendConfirmationEmail: vi.fn().mockResolvedValue("test-message-id") };
    confirmation = new EmailConfirmationService({
      userRepository: repository, brevoEmailService: sender, appBaseUrl: "https://macrolog.example"
    });
    service = new UserService(repository, {
      passwordRounds: 4, requireEmailConfirmation: true, emailConfirmationService: confirmation
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function register() {
    return service.register({ email: "persona@example.test", password: USER_PASSWORD });
  }

  it("delega la creación pendiente, calcula bcrypt y devuelve exclusivamente el usuario público", async () => {
    const create = vi.spyOn(confirmation, "registerPendingAccount");
    const user = await register();
    const stored = await repository.findById(user.id);
    expect(create).toHaveBeenCalledOnce();
    expect(stored).toMatchObject({ confirmed: false, role: "user", deletedAt: null });
    expect(await bcrypt.compare(USER_PASSWORD, stored.passwordHash)).toBe(true);
    expect(user).toEqual({
      id: stored.id, email: stored.email, role: "user", status: "pending", active: false, createdAt: stored.createdAt
    });
    expect(sender.sendConfirmationEmail).toHaveBeenCalledOnce();
  });

  it("crea administradores confirmados sin emitir tokens ni enviar correo", async () => {
    const admin = await service.createAdmin({ email: "admin@example.test", password: ADMIN_PASSWORD });
    expect(admin).toMatchObject({ role: "admin", status: "active", active: true });
    expect((await repository.findById(admin.id)).confirmed).toBe(true);
    expect(repository.confirmationTokens.size).toBe(0);
    expect(sender.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it("rechaza duplicados normales sin volver a emitir ni enviar", async () => {
    await register();
    await expect(register()).rejects.toMatchObject({ statusCode: 409, code: "EMAIL_ALREADY_EXISTS" });
    expect(sender.sendConfirmationEmail).toHaveBeenCalledOnce();
    expect(repository.confirmationTokens.size).toBe(1);
  });

  it("traduce el duplicado concurrente de email después de que ambas consultas previas no encuentren cuenta", async () => {
    const find = vi.spyOn(repository, "findByEmail");
    const results = await Promise.allSettled([register(), register()]);
    expect(find.mock.results).toHaveLength(2);
    expect(await Promise.all(find.mock.results.map((result) => result.value))).toEqual([null, null]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason)
      .toMatchObject({ statusCode: 409, code: "EMAIL_ALREADY_EXISTS" });
    expect(repository.users).toHaveLength(1);
    expect(repository.confirmationTokens.size).toBe(1);
    expect(sender.sendConfirmationEmail).toHaveBeenCalledOnce();
  });

  it.each(["users_pkey", "email_confirmation_tokens_token_hash_key", undefined])(
    "no traduce como email un error 23505 de la restricción %s", async (constraint) => {
      const error = Object.assign(new Error("Fallo de unicidad de prueba"), { code: "23505", constraint });
      vi.spyOn(repository, "createPendingWithToken").mockRejectedValue(error);
      await expect(register()).rejects.toBe(error);
      expect(sender.sendConfirmationEmail).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])("traduce users_email_key también con confirmación activada=%s", async (enabled) => {
    service.requireEmailConfirmation = enabled;
    const operation = enabled ? "createPendingWithToken" : "create";
    vi.spyOn(repository, operation).mockRejectedValue(Object.assign(new Error("duplicado"), {
      code: "23505", constraint: "users_email_key"
    }));
    await expect(register()).rejects.toMatchObject({ statusCode: 409, code: "EMAIL_ALREADY_EXISTS" });
  });

  it("devuelve el usuario público pendiente conservando cuenta y token si falla el correo", async () => {
    sender.sendConfirmationEmail.mockRejectedValue(new Error("unit-test-api-key-and-private-url"));
    const user = await register();
    expect(user).toMatchObject({ status: "pending", active: false });
    expect(user).not.toHaveProperty("passwordHash");
    const stored = await repository.findByEmail("persona@example.test");
    expect(stored.confirmed).toBe(false);
    expect(repository.confirmationTokens.size).toBe(1);
  });

  it("confirma con proyección pública y permite login únicamente después", async () => {
    const user = await register();
    const token = new URLSearchParams(new URL(sender.sendConfirmationEmail.mock.calls[0][0].confirmationUrl).hash.slice(1)).get("token");
    await expect(service.authenticate({ email: user.email, password: USER_PASSWORD }))
      .rejects.toMatchObject({ code: "ACCOUNT_PENDING" });
    const confirmed = await service.confirmAccount(token);
    expect(confirmed).toMatchObject({ id: user.id, status: "active", active: true });
    expect(Object.keys(confirmed).sort()).toEqual(["id", "email", "role", "status", "active", "createdAt"].sort());
    expect(await service.authenticate({ email: user.email, password: USER_PASSWORD })).toEqual(confirmed);
    await expect(service.confirmAccount(token)).rejects.toMatchObject({ statusCode: 400, code: "INVALID_CONFIRMATION_TOKEN" });
  });

  it("delega reenvíos y traduce la ausencia de confirmación en error público", async () => {
    const resend = vi.spyOn(confirmation, "resendConfirmation");
    await service.resendConfirmation("missing@example.test");
    expect(resend).toHaveBeenCalledExactlyOnceWith("missing@example.test");
    await expect(service.confirmAccount("invalid")).rejects.toMatchObject({ statusCode: 400, code: "INVALID_CONFIRMATION_TOKEN" });
  });

  it("desactivado no confirma ficticiamente ni delega reenvíos", async () => {
    service.requireEmailConfirmation = false;
    const confirm = vi.spyOn(confirmation, "confirmAccount");
    const resend = vi.spyOn(confirmation, "resendConfirmation");
    const user = await register();
    expect(user.active).toBe(true);
    await expect(service.confirmAccount("invalid")).rejects.toMatchObject({ code: "INVALID_CONFIRMATION_TOKEN" });
    await service.resendConfirmation(user.email);
    expect(confirm).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
    expect(sender.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it("no crea cuentas pendientes sin el servicio de confirmación requerido", async () => {
    service.emailConfirmationService = undefined;
    await expect(register()).rejects.toMatchObject({ statusCode: 500, code: "EMAIL_CONFIRMATION_CONFIG_ERROR" });
    expect(repository.users).toHaveLength(0);
    expect(repository.confirmationTokens.size).toBe(0);
  });
});
