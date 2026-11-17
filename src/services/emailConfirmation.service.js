import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../utils/appError.js";
import { normalizeEmail } from "../utils/email.js";
import { logger } from "../utils/logger.js";

function configurationError() {
  return new AppError("La configuración de confirmación de cuentas no es válida", 500, "EMAIL_CONFIRMATION_CONFIG_ERROR");
}

export function validateAppBaseUrl(value, isDevelopment = false) {
  if (typeof isDevelopment !== "boolean" || typeof value !== "string" ||
    /[\u0000-\u0020\u007f\\?#]/.test(value) || !/^https?:\/\//i.test(value)) {
    throw configurationError();
  }
  let url;
  try { url = new URL(value); }
  catch { throw configurationError(); }
  if (!url.hostname || url.username || url.password ||
    !(url.protocol === "https:" || (isDevelopment && url.protocol === "http:" && url.hostname === "localhost"))) {
    throw configurationError();
  }
  return url.href;
}

function newToken() {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, token: { id: randomUUID(), tokenHash: hashToken(rawToken) } };
}

function hashToken(rawToken) {
  return createHash("sha256").update(rawToken).digest("hex");
}

export class EmailConfirmationService {
  #userRepository;
  #brevoEmailService;
  #appBaseUrl;

  constructor({ userRepository, brevoEmailService, appBaseUrl, isDevelopment = false }) {
    this.#appBaseUrl = validateAppBaseUrl(appBaseUrl, isDevelopment);
    if (!userRepository || typeof brevoEmailService?.sendConfirmationEmail !== "function") {
      throw configurationError();
    }
    this.#userRepository = userRepository;
    this.#brevoEmailService = brevoEmailService;
  }

  #send(user, rawToken) {
    const link = new URL("/confirm.html", this.#appBaseUrl);
    link.hash = new URLSearchParams({ token: rawToken }).toString();
    return this.#brevoEmailService.sendConfirmationEmail({ to: user.email, confirmationUrl: link.href });
  }

  async registerPendingAccount(user) {
    const { rawToken, token } = newToken();
    const created = await this.#userRepository.createPendingWithToken(user, token, new Date());
    // La transacción ya ha terminado: un fallo de correo no deshace la cuenta ni su token.
    try { await this.#send(created.user, rawToken); }
    catch {
      logger.error("email.confirmation_delivery_failed", { userId: created.user.id });
    }
    return created.user;
  }

  async confirmAccount(rawToken) {
    if (typeof rawToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const bytes = Buffer.from(rawToken, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== rawToken) return null;
    return this.#userRepository.confirmWithToken(hashToken(rawToken), () => new Date());
  }

  async resendConfirmation(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;
    const user = await this.#userRepository.findByEmail(normalizedEmail);
    if (!user || user.confirmed || user.deletedAt) return;
    const { rawToken, token } = newToken();
    const issued = await this.#userRepository.issueConfirmationToken(user.id, token, () => new Date());
    if (!issued) return;
    try { await this.#send(user, rawToken); }
    catch {
      // Respuesta genérica también cuando falla Brevo; se conserva la emisión para los límites.
    }
  }
}
