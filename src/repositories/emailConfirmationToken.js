export const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const TOKEN_COOLDOWN_MS = 60 * 1000;
export const TOKEN_DAILY_LIMIT = 5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function confirmationTime(now) {
  if (!(now instanceof Date) && typeof now !== "string") {
    throw new TypeError("Debes proporcionar la fecha actual");
  }
  const time = new Date(now);
  if (!Number.isFinite(time.getTime())) throw new TypeError("Fecha actual inválida");
  return time.toISOString();
}

export function normalizeTokenHash(hash) {
  return typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
}

export function buildConfirmationToken(userId, token, now) {
  const tokenHash = normalizeTokenHash(token?.tokenHash);
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(token?.id) || !tokenHash) {
    throw new TypeError("El token requiere UUID, propietario y hash SHA-256 válidos");
  }
  const createdAt = confirmationTime(now);
  // Solo estos campos se almacenan: nunca un token original recibido en el objeto.
  return {
    id: token.id.toLowerCase(),
    userId,
    tokenHash,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + TOKEN_LIFETIME_MS).toISOString(),
    usedAt: null,
    revokedAt: null
  };
}

export function buildPendingUser(user, now) {
  if (!user || user.confirmed !== false || user.deletedAt) {
    throw new TypeError("La cuenta debe estar pendiente y no eliminada");
  }
  return {
    id: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    role: user.role,
    confirmed: false,
    deletedAt: null,
    createdAt: confirmationTime(now),
    updatedAt: confirmationTime(now)
  };
}

export function canIssueConfirmationToken(count, lastCreatedAt, now) {
  return count < TOKEN_DAILY_LIMIT &&
    (!lastCreatedAt || Date.parse(now) - Date.parse(lastCreatedAt) >= TOKEN_COOLDOWN_MS);
}

export function isUsableConfirmationToken(token, now) {
  const time = Date.parse(now);
  return Boolean(token && !token.usedAt && !token.revokedAt &&
    Date.parse(token.createdAt) <= time && Date.parse(token.expiresAt) > time);
}
