import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrevoEmailService } from "../src/services/brevoEmail.service.js";
import { buildConfirmationEmail } from "../src/services/emailTemplates/confirmationEmail.js";
import { AppError } from "../src/utils/appError.js";

const API_KEY = "unit-test-api-key-never-real";
const CONFIRMATION_URL = "https://macrolog.example/confirm?token=unit-test-token&source=registration";
const MESSAGE_ID = "<fixture@brevo.example>";
const REQUEST = { to: "recipient@example.test", confirmationUrl: CONFIRMATION_URL };
const CONFIG = { apiKey: API_KEY, senderEmail: "sender@example.test", senderName: "MacroLog" };

describe("BrevoEmailService, sin conexiones externas", () => {
  let fetchMock;
  let service;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: MESSAGE_ID }), { status: 201 }));
    // También bloquea llamadas accidentales si se omitiese la inyección de fetch.
    vi.stubGlobal("fetch", fetchMock);
    service = new BrevoEmailService({ ...CONFIG, fetchImpl: fetchMock });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("envía al endpoint oficial con cabeceras, payload exacto y únicamente htmlContent", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(await service.sendConfirmationEmail(REQUEST)).toBe(MESSAGE_ID);
    expect(timeout).toHaveBeenCalledWith(10000);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { email: CONFIG.senderEmail, name: CONFIG.senderName },
        to: [{ email: REQUEST.to }],
        subject: "Confirma tu cuenta de MacroLog",
        htmlContent: buildConfirmationEmail(CONFIRMATION_URL)
      }),
      signal: expect.any(AbortSignal),
      redirect: "error"
    });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).not.toHaveProperty("textContent");
    expect(payload).not.toHaveProperty("templateId");
  });

  it("admite fetch nativo sustituido por un doble y normaliza remitente y destinatario", async () => {
    service = new BrevoEmailService({ apiKey: API_KEY, senderEmail: " Sender@Example.Test " });
    await service.sendConfirmationEmail({ ...REQUEST, to: " Recipient@Example.Test " });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.sender).toEqual({ email: "sender@example.test", name: "MacroLog" });
    expect(payload.to).toEqual([{ email: "recipient@example.test" }]);
  });

  it("utiliza exclusivamente el fetch inyectado aunque exista un fetch global distinto", async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error("El fetch global no debe utilizarse"));
    const injectedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: MESSAGE_ID }), { status: 201 }));
    vi.stubGlobal("fetch", globalFetch);
    service = new BrevoEmailService({ ...CONFIG, fetchImpl: injectedFetch });

    expect(await service.sendConfirmationEmail(REQUEST)).toBe(MESSAGE_ID);
    expect(injectedFetch).toHaveBeenCalledExactlyOnceWith("https://api.brevo.com/v3/smtp/email", expect.objectContaining({ method: "POST" }));
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, 123, {}, [], "", "missing-domain", "a@@example.test", "a@localhost",
    "one@example.test,two@example.test", "<one@example.test>", "user..name@example.test",
    ".user@example.test", "user.@example.test", "user@-example.test", "user@example..test",
    "user@example.test\r\nBcc: other@example.test", `${"a".repeat(65)}@example.test`
  ])("rechaza un destinatario inválido sin enviar: %j", async (to) => {
    await expect(service.sendConfirmationEmail({ ...REQUEST, to })).rejects.toMatchObject({
      statusCode: 400, code: "INVALID_EMAIL_RECIPIENT"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], "invalid"])("valida el argumento completo: %j", async (data) => {
    await expect(service.sendConfirmationEmail(data)).rejects.toMatchObject({ code: "INVALID_EMAIL_RECIPIENT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, 42, {}, [], "", "/confirm?token=fixture", "//example.test/confirm",
    "https://", "https:example.test/confirm", " https://example.test/confirm",
    "https://example.test/confirm\n", "https://example.test/a b", "https:\\example.test\\confirm",
    "javascript:alert(1)", "data:text/html,fixture", "file:///confirm", "ftp://example.test/confirm",
    "http://example.test/confirm", "http://localhost:3000/confirm",
    "https://user:password@example.test/confirm", "https://user@example.test/confirm",
    "https://:password@example.test/confirm", "https://user%40example.test:password@example.test/confirm"
  ])("rechaza una URL inválida o no permitida sin enviar: %j", async (confirmationUrl) => {
    await expect(service.sendConfirmationEmail({ ...REQUEST, confirmationUrl })).rejects.toMatchObject({
      statusCode: 400, code: "INVALID_CONFIRMATION_URL"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("permite HTTP en localhost únicamente al habilitar desarrollo explícitamente", async () => {
    service = new BrevoEmailService({ ...CONFIG, isDevelopment: true, fetchImpl: fetchMock });
    const url = "http://localhost:3000/confirm?token=fixture";
    expect(await service.sendConfirmationEmail({ ...REQUEST, confirmationUrl: url })).toBe(MESSAGE_ID);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).htmlContent).toContain(`href="${url}"`);
  });

  it.each(["http://localhost.example.test/confirm", "http://example.test/confirm", "http://user:pass@localhost/confirm"])(
    "el modo desarrollo no permite excepciones fuera de localhost sin credenciales: %s", async (confirmationUrl) => {
      service = new BrevoEmailService({ ...CONFIG, isDevelopment: true, fetchImpl: fetchMock });
      await expect(service.sendConfirmationEmail({ ...REQUEST, confirmationUrl })).rejects.toMatchObject({ code: "INVALID_CONFIRMATION_URL" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    { apiKey: undefined }, { apiKey: null }, { apiKey: "" }, { apiKey: " " }, { apiKey: "key\r\nheader" },
    { apiKey: 123 }, { senderEmail: undefined }, { senderEmail: "bad-address" }, { senderEmail: "a@example.test\n" },
    { senderName: " " }, { senderName: null }, { senderName: "name\r\nheader" },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: 60001 }, { timeoutMs: Infinity },
    { timeoutMs: "1000" }, { fetchImpl: null }, { isDevelopment: "true" }
  ])("rechaza configuración inválida sin enviar: %j", (changes) => {
    expect(() => new BrevoEmailService({ ...CONFIG, fetchImpl: fetchMock, ...changes }))
      .toThrow("La configuración del servicio de correo no es válida");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], "invalid"])("rechaza configuración ausente o de tipo incorrecto: %j", (options) => {
    expect(() => new BrevoEmailService(options)).toThrow(AppError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 422, 500, 502, 503])("traduce HTTP %i sin leer ni exponer el cuerpo y sin reintentos", async (status) => {
    const json = vi.fn().mockResolvedValue({ message: `${API_KEY} ${CONFIRMATION_URL}` });
    fetchMock.mockResolvedValue({ status, ok: false, json });
    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({ statusCode: 502, code: "EMAIL_PROVIDER_ERROR" });
    expect(json).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("traduce el límite HTTP 429 a indisponibilidad temporal sin reintentar", async () => {
    fetchMock.mockResolvedValue(new Response("sensitive-provider-body", { status: 429 }));
    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({ statusCode: 503, code: "EMAIL_RATE_LIMITED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 429, 500, 503])("cancela el ReadableStream de HTTP %i sin leer su contenido", async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${API_KEY} ${CONFIRMATION_URL}`)); },
      cancel
    }), { status });
    const json = vi.spyOn(response, "json");
    const text = vi.spyOn(response, "text");
    fetchMock.mockResolvedValue(response);

    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({
      statusCode: status === 429 ? 503 : 502,
      code: status === 429 ? "EMAIL_RATE_LIMITED" : "EMAIL_PROVIDER_ERROR"
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("espera la resolución de la cancelación antes de rechazar el envío", async () => {
    let release;
    let entered;
    const cancelled = new Promise((resolve) => { release = resolve; });
    const cancelling = new Promise((resolve) => { entered = resolve; });
    const response = new Response(new ReadableStream({
      cancel() { entered(); return cancelled; }
    }), { status: 400 });
    fetchMock.mockResolvedValue(response);
    let settled = false;
    const pending = service.sendConfirmationEmail(REQUEST).catch((error) => { settled = true; return error; });

    await cancelling;
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await pending).toMatchObject({ code: "EMAIL_PROVIDER_ERROR", statusCode: 502 });
    expect(settled).toBe(true);
  });

  it.each([400, 429, 503])("conserva el error de HTTP %i si falla la cancelación del stream", async (status) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const failure = new Error(`${API_KEY} ${CONFIRMATION_URL}`);
    const cancel = vi.fn(() => {
      if (status === 400) throw failure;
      return Promise.reject(failure);
    });
    const response = new Response(new ReadableStream({ cancel }), { status });
    fetchMock.mockResolvedValue(response);

    const error = await service.sendConfirmationEmail(REQUEST).catch((caught) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: status === 429 ? 503 : 502,
      code: status === 429 ? "EMAIL_RATE_LIMITED" : "EMAIL_PROVIDER_ERROR",
      message: status === 429
        ? "El servicio de correo no está disponible temporalmente"
        : "El servicio de correo no ha aceptado el envío"
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    for (const representation of [String(error), error.stack, JSON.stringify(error)]) {
      expect(representation).not.toContain(API_KEY);
      expect(representation).not.toContain(CONFIRMATION_URL);
      expect(representation).not.toContain("unit-test-token");
    }
    expect(error).not.toHaveProperty("cause");
    for (const output of [log, errorLog, warn, info]) expect(output).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 429, 500])("no intenta cancelar cuando HTTP %i tiene body null", async (status) => {
    const response = new Response(null, { status });
    expect(response.body).toBeNull();
    const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
    fetchMock.mockResolvedValue(response);
    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({
      code: status === 429 ? "EMAIL_RATE_LIMITED" : "EMAIL_PROVIDER_ERROR"
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("procesa el JSON satisfactorio sin cancelar su cuerpo", async () => {
    const response = new Response(JSON.stringify({ messageId: MESSAGE_ID }), { status: 201 });
    const cancel = vi.spyOn(response.body, "cancel");
    fetchMock.mockResolvedValue(response);
    expect(await service.sendConfirmationEmail(REQUEST)).toBe(MESSAGE_ID);
    expect(response.bodyUsed).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([new TypeError("network fixture"), new Error("network fixture"), new AppError(`${API_KEY} ${CONFIRMATION_URL}`, 500)])(
    "sanea cualquier error de transporte, incluso AppError ajenos: %s", async (failure) => {
      fetchMock.mockRejectedValue(failure);
      const error = await service.sendConfirmationEmail(REQUEST).catch((caught) => caught);
      expect(error).toMatchObject({ statusCode: 502, code: "EMAIL_NETWORK_ERROR" });
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain(CONFIRMATION_URL);
      expect(error).not.toHaveProperty("cause");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("aplica el timeout configurable real de AbortSignal.timeout durante fetch", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    service = new BrevoEmailService({ ...CONFIG, timeoutMs: 20, fetchImpl: fetchMock });
    fetchMock.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({ statusCode: 504, code: "EMAIL_SEND_TIMEOUT" });
    expect(timeout).toHaveBeenCalledWith(20);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mantiene el timeout durante la lectura del cuerpo de la respuesta", async () => {
    service = new BrevoEmailService({ ...CONFIG, timeoutMs: 20, fetchImpl: fetchMock });
    fetchMock.mockImplementation(async (_url, { signal }) => ({
      status: 201, ok: true,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    }));
    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({ code: "EMAIL_SEND_TIMEOUT" });
  });

  it("clasifica como respuesta inválida un JSON realmente malformado", async () => {
    fetchMock.mockResolvedValue(new Response(`invalid-json ${API_KEY} ${CONFIRMATION_URL}`, { status: 201 }));
    const error = await service.sendConfirmationEmail(REQUEST).catch((caught) => caught);
    expect(error).toMatchObject({
      statusCode: 502, code: "EMAIL_PROVIDER_INVALID_RESPONSE",
      message: "El servicio de correo devolvió una respuesta inesperada"
    });
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(CONFIRMATION_URL);
    expect(error).not.toHaveProperty("cause");
  });

  it("clasifica como comunicación un fallo del stream mientras se lee el JSON", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"messageId":')); },
      pull(controller) { controller.error(new TypeError(`${API_KEY} ${CONFIRMATION_URL}`)); }
    }), { status: 201 });
    fetchMock.mockResolvedValue(response);
    const error = await service.sendConfirmationEmail(REQUEST).catch((caught) => caught);
    expect(error).toMatchObject({
      statusCode: 502, code: "EMAIL_NETWORK_ERROR",
      message: "No se ha podido contactar con el servicio de correo"
    });
    for (const representation of [String(error), error.stack, JSON.stringify(error)]) {
      expect(representation).not.toContain(API_KEY);
      expect(representation).not.toContain(CONFIRMATION_URL);
    }
    expect(error).not.toHaveProperty("cause");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["TimeoutError", "AbortError"])("sanea errores de aborto %s sin revelar sus mensajes", async (name) => {
    fetchMock.mockRejectedValue(new DOMException(`${API_KEY} ${CONFIRMATION_URL}`, name));
    const error = await service.sendConfirmationEmail(REQUEST).catch((caught) => caught);
    expect(error).toMatchObject({ code: "EMAIL_SEND_TIMEOUT" });
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(CONFIRMATION_URL);
  });

  it.each([null, undefined, {}, { status: 201 }, { status: "201", ok: true }, { status: 201, ok: false },
    { status: 700, ok: true }, { status: 201, ok: true }])("rechaza respuestas de transporte inesperadas: %j", async (response) => {
    fetchMock.mockResolvedValue(response);
    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({ code: "EMAIL_PROVIDER_INVALID_RESPONSE" });
  });

  it.each([null, [], {}, { messageId: "" }, { messageId: " " }, { messageId: 123 }, { messageIds: [MESSAGE_ID] },
    { messageId: "fixture\r\nsensitive" }])("rechaza respuestas sin messageId válido: %j", async (payload) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 201 }));
    await expect(service.sendConfirmationEmail(REQUEST)).rejects.toMatchObject({ code: "EMAIL_PROVIDER_INVALID_RESPONSE" });
  });

  it("sanea JSON inválido sin registrar credenciales, enlaces ni contenido de Brevo", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ status: 201, ok: true, json: vi.fn().mockRejectedValue(new SyntaxError(`${API_KEY} ${CONFIRMATION_URL}`)) });
    const error = await service.sendConfirmationEmail(REQUEST).catch((caught) => caught);
    expect(error).toMatchObject({ code: "EMAIL_PROVIDER_INVALID_RESPONSE" });
    for (const representation of [String(error), error.stack, JSON.stringify(error)]) {
      expect(representation).not.toContain(API_KEY);
      expect(representation).not.toContain(CONFIRMATION_URL);
      expect(representation).not.toContain("unit-test-token");
    }
    expect(error).not.toHaveProperty("cause");
    for (const output of [log, errorLog, warn, info]) expect(output).not.toHaveBeenCalled();
  });
});
