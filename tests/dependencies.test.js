import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDependencies, parseEmailConfirmationSetting } from "../src/config/dependencies.js";
import { createDatabasePool, initializeDatabase } from "../src/config/database.js";
import { BrevoEmailService } from "../src/services/brevoEmail.service.js";
import { EmailConfirmationService } from "../src/services/emailConfirmation.service.js";

vi.mock("../src/config/database.js", () => ({ createDatabasePool: vi.fn(), initializeDatabase: vi.fn() }));

const CONFIG = {
  requireEmailConfirmation: true, brevoApiKey: "unit-test-api-key-not-real",
  brevoSenderEmail: "sender@example.test", brevoSenderName: "MacroLog", appBaseUrl: "https://macrolog.example"
};

describe("Composición RF-02, sin PostgreSQL ni Brevo reales", () => {
  let pool;
  let fetchMock;
  beforeEach(() => {
    vi.clearAllMocks();
    pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    vi.mocked(createDatabasePool).mockReturnValue(pool);
    vi.mocked(initializeDatabase).mockResolvedValue(undefined);
    fetchMock = vi.fn().mockRejectedValue(new Error("No se permiten conexiones externas"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("desactivado no exige configuración ni instancia ningún servicio de correo", async () => {
    const deps = await createDependencies({ requireEmailConfirmation: false });
    expect(deps.brevoEmailService).toBeUndefined();
    expect(deps.emailConfirmationService).toBeUndefined();
    expect(deps.userService.requireEmailConfirmation).toBe(false);
    expect(createDatabasePool).toHaveBeenCalledOnce();
    expect(initializeDatabase).toHaveBeenCalledExactlyOnceWith(pool);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("activado construye e inyecta las dependencias con configuración completa", async () => {
    const deps = await createDependencies(CONFIG);
    expect(deps.brevoEmailService).toBeInstanceOf(BrevoEmailService);
    expect(deps.emailConfirmationService).toBeInstanceOf(EmailConfirmationService);
    expect(deps.userService.emailConfirmationService).toBe(deps.emailConfirmationService);
    expect(deps.userService.userRepository).toBe(deps.userRepository);
    expect(deps.userService.requireEmailConfirmation).toBe(true);
    expect(createDatabasePool).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["brevoApiKey", "brevoSenderEmail", "brevoSenderName", "appBaseUrl"])(
    "falla antes de abrir PostgreSQL si falta %s, sin filtrar configuración", async (key) => {
      const error = await createDependencies({ ...CONFIG, [key]: undefined }).catch((failure) => failure);
      expect(error).toMatchObject({ statusCode: 500 });
      expect(error.code).toMatch(/^EMAIL_(SERVICE|CONFIRMATION)_CONFIG_ERROR$/);
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(CONFIG.brevoApiKey);
      expect(createDatabasePool).not.toHaveBeenCalled();
      expect(initializeDatabase).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    { brevoApiKey: "" }, { brevoSenderEmail: "invalid" }, { brevoSenderName: "bad\nname" },
    { appBaseUrl: "https://user:password@example.test" }, { appBaseUrl: "https://example.test?token=fixture" },
    { appBaseUrl: "http://localhost:3000" }
  ])("rechaza configuración inválida antes de conectar: %j", async (changes) => {
    await expect(createDependencies({ ...CONFIG, ...changes })).rejects.toMatchObject({ statusCode: 500 });
    expect(createDatabasePool).not.toHaveBeenCalled();
  });

  it("permite HTTP localhost exclusivamente al indicar desarrollo", async () => {
    const deps = await createDependencies({ ...CONFIG, appBaseUrl: "http://localhost:3000", isDevelopment: true });
    expect(deps.emailConfirmationService).toBeInstanceOf(EmailConfirmationService);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "false", "TRUE", "invalid", false, true, 1])(
    "producción rechaza REQUIRE_EMAIL_CONFIRMATION ausente, inválida o desactivada: %j", (value) => {
      expect(() => parseEmailConfirmationSetting(value, { isProduction: true }))
        .toThrow(expect.objectContaining({ code: "EMAIL_CONFIRMATION_CONFIG_ERROR" }));
    }
  );

  it("producción acepta exclusivamente true explícito y compone el servicio", async () => {
    expect(parseEmailConfirmationSetting("true", { isProduction: true })).toBe(true);
    const deps = await createDependencies({ ...CONFIG, isProduction: true });
    expect(deps.emailConfirmationService).toBeInstanceOf(EmailConfirmationService);
  });

  it.each([undefined, false, "true", "false"])("composición tampoco permite desactivar producción: %j", async (value) => {
    await expect(createDependencies({ ...CONFIG, isProduction: true, requireEmailConfirmation: value }))
      .rejects.toMatchObject({ code: "EMAIL_CONFIRMATION_CONFIG_ERROR" });
    expect(createDatabasePool).not.toHaveBeenCalled();
  });

  it("desarrollo permite desactivación explícita y rechaza valores ausentes o inválidos", () => {
    expect(parseEmailConfirmationSetting("false")).toBe(false);
    expect(parseEmailConfirmationSetting("true")).toBe(true);
    for (const value of [undefined, "", "invalid"]) {
      expect(() => parseEmailConfirmationSetting(value)).toThrow();
    }
  });

  it("producción exige HTTPS incluso si se indica desarrollo simultáneamente", async () => {
    await expect(createDependencies({ ...CONFIG, isProduction: true, isDevelopment: true, appBaseUrl: "http://localhost:3000" }))
      .rejects.toMatchObject({ code: "EMAIL_CONFIRMATION_CONFIG_ERROR" });
    expect(createDatabasePool).not.toHaveBeenCalled();
  });

  it.each(["brevoApiKey", "brevoSenderEmail", "brevoSenderName", "appBaseUrl"])(
    "producción no conecta PostgreSQL si falta %s", async (key) => {
      await expect(createDependencies({ ...CONFIG, isProduction: true, [key]: undefined })).rejects.toMatchObject({ statusCode: 500 });
      expect(createDatabasePool).not.toHaveBeenCalled();
    }
  );
});
