import request from "supertest";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "./helpers/testContext.js";
import { logger } from "../src/utils/logger.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const USER_EMAIL = "persona@example.com";
const USER_PASSWORD = "Usuario1234";

describe("API de autenticación y usuarios", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registra un usuario sin exponer el hash", async () => {
    const { app } = await createTestContext();

    const response = await request(app)
      .post("/api/auth/register")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe(USER_EMAIL);
    expect(response.body.user).not.toHaveProperty("passwordHash");
  });

  it("mantiene la sesión después del login", async () => {
    const { app } = await createTestContext();
    const agent = request.agent(app);

    await agent
      .post("/api/auth/register")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    const loginResponse = await agent
      .post("/api/auth/login")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    const sessionResponse = await agent.get("/api/auth/session");

    expect(loginResponse.status).toBe(200);
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.body.authenticated).toBe(true);
    expect(sessionResponse.body.user.email).toBe(USER_EMAIL);
  });

  it("rechaza credenciales incorrectas", async () => {
    const { app } = await createTestContext();

    await request(app)
      .post("/api/auth/register")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    const response = await request(app)
      .post("/api/auth/login")
      .send({
        email: USER_EMAIL,
        password: "ContraseñaIncorrecta"
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it.each([
    ["numérica", 12345678],
    ["objeto", { password: USER_PASSWORD }],
    ["array", [USER_PASSWORD]],
    ["null", null],
    ["ausente", undefined]
  ])("rechaza una contraseña %s sin revelar si existe la cuenta", async (_, password) => {
    const { app, userRepository } = await createTestContext();
    const registered = await request(app)
      .post("/api/auth/register")
      .send({ email: USER_EMAIL, password: USER_PASSWORD });

    const expectedError = {
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Email o contraseña incorrectos"
      }
    };

    // La respuesta debe ser idéntica para cuentas activas, pendientes e inexistentes.
    for (const state of ["active", "pending", "missing"]) {
      if (state === "pending") {
        await userRepository.update(registered.body.user.id, { confirmed: false });
      }

      const response = await request(app)
        .post("/api/auth/login")
        .send({
          email: state === "missing" ? "inexistente@example.com" : USER_EMAIL,
          password
        });

      expect(response.status).toBe(401);
      expect(response.body).toEqual(expectedError);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it.each([false, true])(
    "invalida la sesión del usuario eliminado por un administrador (producción: %s)",
    async (isProduction) => {
      const { app, adminCredentials, sessionStore } = await createTestContext({ isProduction });
      const logSpy = vi.spyOn(logger, "info");
      const registered = await request(app)
        .post("/api/auth/register")
        .send({ email: USER_EMAIL, password: USER_PASSWORD });
      const userId = registered.body.user.id;
      const login = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-Proto", "https")
        .send({ email: USER_EMAIL, password: USER_PASSWORD });
      const originalCookie = login.headers["set-cookie"][0].split(";")[0];
      const sessions = await promisify(sessionStore.all.bind(sessionStore))();
      const sessionId = Object.keys(sessions).find((id) => sessions[id].userId === userId);

      expect(login.status).toBe(200);
      expect(sessionId).toBeDefined();

      const adminLogin = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-Proto", "https")
        .send(adminCredentials);
      expect(adminLogin.status).toBe(200);

      const deleted = await request(app)
        .delete(`/api/users/${userId}`)
        .set("X-Forwarded-Proto", "https")
        .set("Cookie", adminLogin.headers["set-cookie"][0].split(";")[0]);
      expect(deleted.status).toBe(200);

      const response = await request(app)
        .get("/api/auth/session")
        .set("X-Forwarded-Proto", "https")
        .set("Cookie", originalCookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: false });
      const clearedCookie = response.headers["set-cookie"].find((cookie) => cookie.startsWith("macrolog.sid="));
      expect(clearedCookie).toMatch(/^macrolog\.sid=;/);
      expect(clearedCookie).toContain("Path=/");
      expect(clearedCookie).toContain("HttpOnly");
      expect(clearedCookie).toContain("SameSite=Lax");
      expect(clearedCookie.includes("Secure")).toBe(isProduction);
      expect(clearedCookie).not.toContain("Max-Age=");
      const expires = /Expires=([^;]+)/.exec(clearedCookie);
      expect(expires).not.toBeNull();
      expect(new Date(expires[1]).getTime()).toBeLessThan(Date.now());
      expect(await promisify(sessionStore.get.bind(sessionStore))(sessionId)).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith("session.invalidated", { userId });

      // Reutilizar la cookie antigua tampoco debe recuperar la sesión destruida.
      const replay = await request(app)
        .get("/api/auth/session")
        .set("X-Forwarded-Proto", "https")
        .set("Cookie", originalCookie);
      expect(replay.body).toEqual({ authenticated: false });
      expect(replay.headers["set-cookie"]).toBeUndefined();
    }
  );

  it.each(["missing", "pending"])(
    "destruye la sesión cuando la cuenta pasa a estar %s",
    async (state) => {
      const { app, userRepository, sessionStore } = await createTestContext();
      const agent = request.agent(app);
      const registered = await agent
        .post("/api/auth/register")
        .send({ email: USER_EMAIL, password: USER_PASSWORD });
      await agent.post("/api/auth/login").send({ email: USER_EMAIL, password: USER_PASSWORD });
      const sessions = await promisify(sessionStore.all.bind(sessionStore))();
      const sessionId = Object.keys(sessions).find((id) => sessions[id].userId === registered.body.user.id);
      expect(sessionId).toBeDefined();

      if (state === "missing") {
        vi.spyOn(userRepository, "findById").mockResolvedValue(null);
      } else {
        await userRepository.update(registered.body.user.id, { confirmed: false });
      }

      const response = await agent.get("/api/auth/session");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: false });
      expect(response.headers["set-cookie"][0]).toMatch(/^macrolog\.sid=;/);
      expect(await promisify(sessionStore.get.bind(sessionStore))(sessionId)).toBeUndefined();
    }
  );

  it("no confunde un fallo del repositorio con una cuenta inválida", async () => {
    const { app, userRepository } = await createTestContext();
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: USER_EMAIL, password: USER_PASSWORD });
    await agent.post("/api/auth/login").send({ email: USER_EMAIL, password: USER_PASSWORD });
    vi.spyOn(userRepository, "findById").mockRejectedValue(new Error("Repositorio no disponible"));

    const response = await agent.get("/api/auth/session");
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rechaza rutas privadas sin una sesión", async () => {
    const { app } = await createTestContext();

    const response = await request(app).get("/api/users");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe(
      "AUTHENTICATION_REQUIRED"
    );
  });

  it("impide que un usuario normal liste usuarios", async () => {
    const { app } = await createTestContext();
    const agent = request.agent(app);

    await agent
      .post("/api/auth/register")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    await agent
      .post("/api/auth/login")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    const response = await agent.get("/api/users");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ADMIN_REQUIRED");
  });

  it("permite al administrador listar usuarios", async () => {
    const { app, adminCredentials } = await createTestContext();
    const agent = request.agent(app);

    await request(app)
      .post("/api/auth/register")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    await agent
      .post("/api/auth/login")
      .send(adminCredentials);

    const response = await agent.get("/api/users");

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(2);
  });

  it("el logout invalida la sesión", async () => {
    const { app } = await createTestContext();
    const agent = request.agent(app);

    await agent
      .post("/api/auth/register")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    await agent
      .post("/api/auth/login")
      .send({
        email: USER_EMAIL,
        password: USER_PASSWORD
      });

    const logoutResponse = await agent.post("/api/auth/logout");
    const protectedResponse = await agent.get("/api/users");

    expect(logoutResponse.status).toBe(204);
    expect(protectedResponse.status).toBe(401);
  });
});

describe("API RF-02: registro, confirmación y reenvío", () => {
  afterEach(() => vi.restoreAllMocks());
  const tokenFrom = (message) => new URLSearchParams(new URL(message.confirmationUrl).hash.slice(1)).get("token");
  const hash = (token) => createHash("sha256").update(token).digest("hex");
  const register = (app) => request(app).post("/api/auth/register").send({ email: USER_EMAIL, password: USER_PASSWORD });
  const generic = {
    message: "Si la cuenta está pendiente y puede recibir otro correo, enviaremos un enlace de confirmación."
  };

  it("registra pendiente, confirma sin sesión y solo después permite login; ignora cabeceras para el enlace", async () => {
    const { app, sentEmails, sessionStore } = await createTestContext({ requireEmailConfirmation: true });
    const set = vi.spyOn(sessionStore, "set");
    const regenerate = vi.spyOn(sessionStore, "regenerate");
    const agent = request.agent(app);
    const registered = await agent.post("/api/auth/register")
      .set("Host", "attacker.example").set("Origin", "https://attacker.example").set("Referer", "https://attacker.example")
      .send({ email: USER_EMAIL, password: USER_PASSWORD });
    expect(registered.status).toBe(201);
    expect(registered.body.user).toMatchObject({ status: "pending", active: false });
    expect(registered.headers["set-cookie"]).toBeUndefined();
    const message = sentEmails[0];
    const raw = tokenFrom(message);
    const link = new URL(message.confirmationUrl);
    expect(link.origin).toBe("https://macrolog.example");
    expect(link.pathname).toBe("/confirm.html");
    expect(link.search).toBe("");
    const pendingLogin = await agent.post("/api/auth/login").send({ email: USER_EMAIL, password: USER_PASSWORD });
    expect(pendingLogin.status).toBe(403);
    expect(pendingLogin.body.error.code).toBe("ACCOUNT_PENDING");
    const confirmed = await agent.post("/api/auth/confirm").send({ token: raw });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.user).toMatchObject({ id: registered.body.user.id, status: "active", active: true });
    expect(Object.keys(confirmed.body.user).sort()).toEqual(["id", "email", "role", "status", "active", "createdAt"].sort());
    expect(JSON.stringify(registered.body)).not.toContain(raw);
    expect(JSON.stringify(confirmed.body)).not.toContain(raw);
    expect(JSON.stringify(confirmed.body)).not.toContain(USER_PASSWORD);
    expect(confirmed.headers["set-cookie"]).toBeUndefined();
    expect((await agent.get("/api/auth/session")).body).toEqual({ authenticated: false });
    expect(set).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
    const login = await agent.post("/api/auth/login").send({ email: USER_EMAIL, password: USER_PASSWORD });
    expect(login.status).toBe(200);
    expect((await agent.get("/api/auth/session")).body.authenticated).toBe(true);
  });

  it.each([undefined, null, 123, {}, [], "bad-token", "A".repeat(42) + "B", randomBytes(32).toString("base64url")])(
    "devuelve 400 genérico sin sesión para token inválido: %j", async (token) => {
      const { app } = await createTestContext({ requireEmailConfirmation: true });
      const response = await request(app).post("/api/auth/confirm").send({ token });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_CONFIRMATION_TOKEN");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  );

  it.each(["expired", "used", "revoked", "deleted", "confirmed"])("rechaza confirmación en estado %s", async (state) => {
    const { app, sentEmails, userRepository } = await createTestContext({ requireEmailConfirmation: true });
    const registered = await register(app);
    const raw = tokenFrom(sentEmails[0]);
    const stored = userRepository.confirmationTokens.get(hash(raw));
    if (state === "expired") stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    if (state === "used") stored.usedAt = new Date().toISOString();
    if (state === "revoked") stored.revokedAt = new Date().toISOString();
    if (state === "deleted") await userRepository.update(registered.body.user.id, { deletedAt: new Date().toISOString() });
    if (state === "confirmed") await userRepository.update(registered.body.user.id, { confirmed: true });
    const response = await request(app).post("/api/auth/confirm").send({ token: raw });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_CONFIRMATION_TOKEN");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("solo una confirmación HTTP simultánea prospera con el repositorio en memoria", async () => {
    const { app, sentEmails } = await createTestContext({ requireEmailConfirmation: true });
    await register(app);
    const token = tokenFrom(sentEmails[0]);
    const results = await Promise.all([1, 2].map(() => request(app).post("/api/auth/confirm").send({ token })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(results.find((response) => response.status === 400).body.error.code).toBe("INVALID_CONFIRMATION_TOKEN");
    expect(results.every((response) => !response.headers["set-cookie"])).toBe(true);
  });

  it("mantiene la sesión preexistente al confirmar otra cuenta, sin regenerarla ni cambiar su usuario", async () => {
    const { app, adminCredentials, sentEmails, sessionStore } = await createTestContext({ requireEmailConfirmation: true });
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send(adminCredentials);
    expect(login.status).toBe(200);
    await register(app);
    const regenerate = vi.spyOn(sessionStore, "regenerate");
    const set = vi.spyOn(sessionStore, "set");
    const response = await agent.post("/api/auth/confirm").send({ token: tokenFrom(sentEmails[0]) });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(regenerate).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect((await agent.get("/api/auth/session")).body.user.email).toBe(adminCredentials.email);
  });

  it("registro duplicado devuelve 409 tanto secuencial como simultáneamente", async () => {
    const { app, sentEmails, userRepository } = await createTestContext({ requireEmailConfirmation: true });
    const results = await Promise.all([register(app), register(app)]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(results.find((response) => response.status === 409).body.error.code).toBe("EMAIL_ALREADY_EXISTS");
    const again = await register(app);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
    expect(userRepository.confirmationTokens.size).toBe(1);
    expect(sentEmails).toHaveLength(1);
  });

  it.each(["missing", "confirmed", "deleted", "cooldown", "limit", "provider-failure", "pending", "invalid"])(
    "reenvío responde exactamente 202 y cuerpo genérico para %s", async (state) => {
      const { app, userRepository, sentEmails, brevoEmailService } = await createTestContext({ requireEmailConfirmation: true });
      if (state !== "missing" && state !== "invalid") {
        const registered = await register(app);
        const userId = registered.body.user.id;
        const initial = [...userRepository.confirmationTokens.values()][0];
        if (state === "confirmed") await userRepository.update(userId, { confirmed: true });
        if (state === "deleted") await userRepository.update(userId, { deletedAt: new Date().toISOString() });
        if (["limit", "provider-failure", "pending"].includes(state)) {
          initial.createdAt = new Date(Date.now() - 3600000).toISOString();
        }
        if (state === "limit") {
          for (let minute = 1; minute <= 4; minute++) {
            const issued = await userRepository.issueConfirmationToken(userId, {
              id: randomUUID(), tokenHash: hash(randomBytes(32))
            }, () => new Date(Date.now() - 3600000 + minute * 60000));
            expect(issued).not.toBeNull();
          }
        }
      }
      const beforeCount = userRepository.confirmationTokens.size;
      const send = vi.spyOn(brevoEmailService, "sendConfirmationEmail");
      if (state === "provider-failure") send.mockRejectedValue(new Error("unit-test-api-key/private-token-link"));
      const response = await request(app).post("/api/auth/resend-confirmation")
        .send({ email: state === "invalid" ? null : ` ${USER_EMAIL.toUpperCase()} ` });
      expect(response.status).toBe(202);
      expect(response.body).toEqual(generic);
      expect(response.headers["set-cookie"]).toBeUndefined();
      const shouldSend = ["pending", "provider-failure"].includes(state);
      expect(send).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
      expect(userRepository.confirmationTokens.size).toBe(beforeCount + (shouldSend ? 1 : 0));
      if (state === "pending") {
        expect(sentEmails).toHaveLength(2);
        expect(tokenFrom(sentEmails[0])).not.toBe(tokenFrom(sentEmails[1]));
      }
    }
  );

  it("el fallo inicial conserva cuenta/token, devuelve 201 habitual y permite recuperar mediante reenvío", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    const brevoEmailService = { sendConfirmationEmail: vi.fn().mockImplementation(async (message) => {
      throw new Error(`unit-test-api-key ${message.confirmationUrl} ${message.to}`);
    }) };
    const { app, userRepository } = await createTestContext({ requireEmailConfirmation: true, brevoEmailService });
    const response = await register(app);
    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email: USER_EMAIL, status: "pending", active: false });
    expect(Object.keys(response.body)).toEqual(["user"]);
    const user = await userRepository.findByEmail(USER_EMAIL);
    expect(user).toMatchObject({ confirmed: false });
    expect(userRepository.confirmationTokens.size).toBe(1);
    const raw = tokenFrom(brevoEmailService.sendConfirmationEmail.mock.calls[0][0]);
    const output = JSON.stringify({ response: response.body, info: info.mock.calls, errors: errors.mock.calls });
    for (const secret of [raw, USER_PASSWORD, user.passwordHash, "unit-test-api-key", "https://macrolog.example"]) {
      expect(output).not.toContain(secret);
    }
    expect(errors).toHaveBeenCalledExactlyOnceWith("email.confirmation_delivery_failed", { userId: user.id });
    expect(JSON.stringify([info.mock.calls, errors.mock.calls])).not.toContain(USER_EMAIL);
    expect((await register(app)).status).toBe(409);
    [...userRepository.confirmationTokens.values()][0].createdAt = new Date(Date.now() - 60001).toISOString();
    brevoEmailService.sendConfirmationEmail.mockResolvedValue("test-message-id");
    const resent = await request(app).post("/api/auth/resend-confirmation").send({ email: USER_EMAIL });
    expect(resent.status).toBe(202);
    expect(resent.body).toEqual(generic);
    expect(userRepository.confirmationTokens.size).toBe(2);
    const recovered = await request(app).post("/api/auth/confirm")
      .send({ token: tokenFrom(brevoEmailService.sendConfirmationEmail.mock.calls[1][0]) });
    expect(recovered.status).toBe(200);
  });

  it("cuenta cualquier email por IP, rechaza la petición 11 antes del servicio y permite continuar a los 15 minutos", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { app, userService, userRepository, adminCredentials } = await createTestContext({ requireEmailConfirmation: true });
    await register(app);
    const resend = vi.spyOn(userService, "resendConfirmation");
    const find = vi.spyOn(userRepository, "findByEmail");
    const emails = [USER_EMAIL, adminCredentials.email, "missing@example.test", null, undefined, 42, {}, [], "bad", "other@example.test"];
    for (const email of emails) {
      const response = await request(app).post("/api/auth/resend-confirmation").send({ email });
      expect(response.status).toBe(202);
      expect(response.body).toEqual(generic);
    }
    expect(resend).toHaveBeenCalledTimes(10);
    const findCount = find.mock.calls.length;
    const blocked = await request(app).post("/api/auth/resend-confirmation").send({ email: USER_EMAIL });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("900");
    expect(blocked.body).toEqual({ error: {
      code: "TOO_MANY_REQUESTS", message: "Demasiadas solicitudes. Inténtalo de nuevo más tarde."
    } });
    expect(resend).toHaveBeenCalledTimes(10);
    expect(find).toHaveBeenCalledTimes(findCount);
    now += 899999;
    const stillBlocked = await request(app).post("/api/auth/resend-confirmation").send({ email: "missing@example.test" });
    expect(stillBlocked.status).toBe(429);
    expect(stillBlocked.body).toEqual(blocked.body);
    expect(stillBlocked.headers["retry-after"]).toBe("1");
    now += 1;
    const allowed = await request(app).post("/api/auth/resend-confirmation").send({ email: "missing@example.test" });
    expect(allowed.status).toBe(202);
    expect(allowed.body).toEqual(generic);
    expect(resend).toHaveBeenCalledTimes(11);
  });

  it.each([false, true])("usa request.ip respetando trust proxy, producción=%s", async (isProduction) => {
    const { app, userService } = await createTestContext({ isProduction });
    const resend = vi.spyOn(userService, "resendConfirmation");
    for (let index = 0; index < 10; index++) {
      const response = await request(app).post("/api/auth/resend-confirmation")
        .set("X-Forwarded-For", "192.0.2.1").send({ email: "missing@example.test" });
      expect(response.status).toBe(202);
    }
    const sameIp = await request(app).post("/api/auth/resend-confirmation")
      .set("X-Forwarded-For", "192.0.2.1").send({ email: USER_EMAIL });
    expect(sameIp.status).toBe(429);
    const differentIp = await request(app).post("/api/auth/resend-confirmation")
      .set("X-Forwarded-For", "192.0.2.2").send({ email: USER_EMAIL });
    expect(differentIp.status).toBe(isProduction ? 202 : 429);
    expect(resend).toHaveBeenCalledTimes(isProduction ? 11 : 10);
    if (!isProduction) expect(differentIp.body).toEqual(sameIp.body);
  });

  it("cada router dispone de su propio limitador", async () => {
    const first = await createTestContext();
    for (let index = 0; index < 11; index++) {
      const response = await request(first.app).post("/api/auth/resend-confirmation").send({ email: null });
      expect(response.status).toBe(index < 10 ? 202 : 429);
    }
    const second = await createTestContext();
    expect((await request(second.app).post("/api/auth/resend-confirmation").send({ email: null })).status).toBe(202);
  });

  it("registro y reenvío no registran emails, tokens, enlaces, contraseñas ni hashes", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { app, sentEmails, userRepository } = await createTestContext({ requireEmailConfirmation: true });
    const registered = await register(app);
    const user = await userRepository.findById(registered.body.user.id);
    [...userRepository.confirmationTokens.values()][0].createdAt = new Date(Date.now() - 60001).toISOString();
    const resent = await request(app).post("/api/auth/resend-confirmation").send({ email: USER_EMAIL });
    expect(resent.status).toBe(202);
    expect(info).toHaveBeenCalledWith("user.registered", { userId: user.id });
    const output = JSON.stringify({ info: info.mock.calls, errors: errors.mock.calls, registered: registered.body, resent: resent.body });
    const logs = JSON.stringify([info.mock.calls, errors.mock.calls]);
    expect(logs).not.toContain(USER_EMAIL);
    for (const secret of [USER_PASSWORD, user.passwordHash, ...sentEmails.flatMap((message) => [message.confirmationUrl, tokenFrom(message)]),
      ...[...userRepository.confirmationTokens.keys()]]) {
      expect(output).not.toContain(secret);
    }
  });

  it("desactivado mantiene registro confirmado, rechaza confirmación ficticia y reenvía genéricamente sin correo", async () => {
    const { app, sentEmails } = await createTestContext();
    expect((await register(app)).body.user).toMatchObject({ status: "active", active: true });
    const confirmed = await request(app).post("/api/auth/confirm").send({ token: randomBytes(32).toString("base64url") });
    expect(confirmed.status).toBe(400);
    expect(confirmed.body.error.code).toBe("INVALID_CONFIRMATION_TOKEN");
    const resend = await request(app).post("/api/auth/resend-confirmation").send({ email: USER_EMAIL });
    expect(resend.status).toBe(202);
    expect(resend.body).toEqual(generic);
    expect(sentEmails).toHaveLength(0);
  });
});
