import request from "supertest";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "./helpers/testContext.js";
import { logger } from "../src/utils/logger.js";

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
