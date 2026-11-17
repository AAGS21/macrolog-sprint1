import { AppError } from "../utils/appError.js";
import { normalizeEmail } from "../utils/email.js";
import { buildConfirmationEmail } from "./emailTemplates/confirmationEmail.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function configurationError() {
  return new AppError("La configuración del servicio de correo no es válida", 500, "EMAIL_SERVICE_CONFIG_ERROR");
}

function invalidResponse() {
  return new AppError("El servicio de correo devolvió una respuesta inesperada", 502, "EMAIL_PROVIDER_INVALID_RESPONSE");
}

function isTimeout(error, signal) {
  return signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError";
}

function timeoutError() {
  return new AppError("El servicio de correo ha superado el tiempo de espera", 504, "EMAIL_SEND_TIMEOUT");
}

function confirmationLink(value, isDevelopment) {
  const invalid = () => new AppError("El enlace de confirmación no es válido", 400, "INVALID_CONFIRMATION_URL");
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value) || !/^https?:\/\//i.test(value)) {
    throw invalid();
  }
  let url;
  try { url = new URL(value); }
  catch { throw invalid(); }
  const permitted = url.protocol === "https:" ||
    (isDevelopment && url.protocol === "http:" && url.hostname === "localhost");
  if (!permitted || !url.hostname || url.username || url.password) throw invalid();
  return url.href;
}

export class BrevoEmailService {
  #apiKey;
  #sender;
  #timeoutMs;
  #isDevelopment;
  #fetch;

  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw configurationError();
    const {
      apiKey, senderEmail, senderName = "MacroLog", timeoutMs = 10000,
      isDevelopment = false, fetchImpl = globalThis.fetch
    } = options;
    const email = normalizeEmail(senderEmail);
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey) || !email ||
      typeof senderName !== "string" || !senderName.trim() || CONTROL_CHARACTERS.test(senderName) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      typeof isDevelopment !== "boolean" || typeof fetchImpl !== "function") {
      throw configurationError();
    }
    this.#apiKey = apiKey;
    this.#sender = { email, name: senderName.trim() };
    this.#timeoutMs = timeoutMs;
    this.#isDevelopment = isDevelopment;
    this.#fetch = fetchImpl;
  }

  async sendConfirmationEmail(data = {}) {
    const to = data && typeof data === "object" && !Array.isArray(data) ? normalizeEmail(data.to) : null;
    if (!to) throw new AppError("El destinatario no tiene un email válido", 400, "INVALID_EMAIL_RECIPIENT");
    const confirmationUrl = confirmationLink(data.confirmationUrl, this.#isDevelopment);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response;
    try {
      response = await this.#fetch(BREVO_ENDPOINT, {
        method: "POST",
        headers: { "api-key": this.#apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sender: this.#sender,
          to: [{ email: to }],
          subject: "Confirma tu cuenta de MacroLog",
          htmlContent: buildConfirmationEmail(confirmationUrl)
        }),
        signal,
        // Una redirección no debe reenviar api-key a otro destino.
        redirect: "error"
      });
    } catch (error) {
      if (isTimeout(error, signal)) throw timeoutError();
      throw new AppError("No se ha podido contactar con el servicio de correo", 502, "EMAIL_NETWORK_ERROR");
    }
    if (signal.aborted) throw timeoutError();
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 ||
      response.ok !== (response.status >= 200 && response.status < 300)) throw invalidResponse();
    if (!response.ok) {
      // No se lee el cuerpo de error: puede contener destinatarios, enlaces o credenciales.
      const error = response.status === 429
        ? new AppError("El servicio de correo no está disponible temporalmente", 503, "EMAIL_RATE_LIMITED")
        : new AppError("El servicio de correo no ha aceptado el envío", 502, "EMAIL_PROVIDER_ERROR");
      try {
        await response.body?.cancel();
      } catch {
        // La liberación no debe sustituir el error HTTP ni exponer su causa.
      }
      throw error;
    }
    if (typeof response.json !== "function") throw invalidResponse();
    let payload;
    try { payload = await response.json(); }
    catch (error) {
      if (isTimeout(error, signal)) throw timeoutError();
      if (error instanceof SyntaxError) throw invalidResponse();
      throw new AppError("No se ha podido contactar con el servicio de correo", 502, "EMAIL_NETWORK_ERROR");
    }
    if (signal.aborted) throw timeoutError();
    if (typeof payload?.messageId !== "string" || !payload.messageId.trim() || CONTROL_CHARACTERS.test(payload.messageId)) {
      throw invalidResponse();
    }
    return payload.messageId;
  }
}
