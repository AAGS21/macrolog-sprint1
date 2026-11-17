import {
  buildConfirmationToken,
  buildPendingUser,
  canIssueConfirmationToken,
  confirmationTime,
  isUsableConfirmationToken,
  normalizeTokenHash,
  TOKEN_LIFETIME_MS
} from "./emailConfirmationToken.js";

function normalizeUuid(id) {
  return typeof id === "string" ? id.toLowerCase() : id;
}

function duplicateConfirmationValue(constraint) {
  const error = new Error("Valor duplicado en la persistencia de confirmación");
  error.code = "23505";
  error.constraint = constraint;
  return error;
}

export class InMemoryUserRepository {
  constructor(initialUsers = []) {
    this.users = initialUsers.map((user) => ({ ...user, id: normalizeUuid(user.id) }));
    this.confirmationTokens = new Map();
  }

  async create(user) {
    const storedUser = { ...user, id: normalizeUuid(user.id) };
    if (this.users.some((existing) => existing.id === storedUser.id)) {
      throw duplicateConfirmationValue("users_pkey");
    }
    if (this.users.some((existing) => existing.email === storedUser.email)) {
      throw duplicateConfirmationValue("users_email_key");
    }
    this.users.push(storedUser);
    return { ...storedUser };
  }

  async findById(id) {
    id = normalizeUuid(id);
    const user = this.users.find((item) => item.id === id);
    return user ? { ...user } : null;
  }

  async findByEmail(email) {
    const user = this.users.find((item) => item.email === email);
    return user ? { ...user } : null;
  }

  async findAll() {
    return this.users.map((user) => ({ ...user }));
  }

  async update(id, changes) {
    id = normalizeUuid(id);
    const index = this.users.findIndex((user) => user.id === id);

    if (index === -1) {
      return null;
    }

    this.users[index] = {
      ...this.users[index],
      ...changes,
      id: normalizeUuid(changes.id ?? this.users[index].id)
    };

    return { ...this.users[index] };
  }

  async createPendingWithToken(user, token, now) {
    const pendingUser = buildPendingUser(user, now);
    pendingUser.id = normalizeUuid(pendingUser.id);
    const storedToken = buildConfirmationToken(pendingUser.id, token, now);
    if (this.users.some((existing) => existing.id === pendingUser.id)) {
      throw duplicateConfirmationValue("users_pkey");
    }
    if (this.users.some((existing) => existing.email === pendingUser.email)) {
      throw duplicateConfirmationValue("users_email_key");
    }
    this.checkConfirmationTokenUniqueness(storedToken);

    // Sin await entre validación y escritura: no hay estado parcial observable.
    this.users.push(pendingUser);
    this.confirmationTokens.set(storedToken.tokenHash, storedToken);
    return { user: { ...pendingUser }, token: { ...storedToken } };
  }

  checkConfirmationTokenUniqueness(token) {
    if (this.confirmationTokens.has(token.tokenHash)) {
      throw duplicateConfirmationValue("email_confirmation_tokens_token_hash_key");
    }
    if ([...this.confirmationTokens.values()].some((existing) => existing.id === token.id)) {
      throw duplicateConfirmationValue("email_confirmation_tokens_pkey");
    }
  }

  async issueConfirmationToken(userId, token, clock = () => new Date()) {
    const time = confirmationTime(clock());
    userId = normalizeUuid(userId);
    const user = this.users.find((existing) => existing.id === userId);
    if (!user || user.confirmed || user.deletedAt) return null;
    const storedToken = buildConfirmationToken(userId, token, time);
    const since = Date.parse(time) - TOKEN_LIFETIME_MS;
    const recent = [...this.confirmationTokens.values()]
      .filter((existing) => existing.userId === userId && Date.parse(existing.createdAt) > since);
    const lastCreatedAt = recent.reduce((latest, existing) =>
      !latest || existing.createdAt > latest ? existing.createdAt : latest, null);
    if (!canIssueConfirmationToken(recent.length, lastCreatedAt, time)) return null;
    this.checkConfirmationTokenUniqueness(storedToken);
    this.confirmationTokens.set(storedToken.tokenHash, storedToken);
    return { ...storedToken };
  }

  async findConfirmationTokenByHash(hash) {
    const normalized = normalizeTokenHash(hash);
    const token = normalized && this.confirmationTokens.get(normalized);
    return token ? { ...token } : null;
  }

  async findValidConfirmationToken(hash, now) {
    const time = confirmationTime(now);
    const normalized = normalizeTokenHash(hash);
    const token = normalized && this.confirmationTokens.get(normalized);
    const user = token && this.users.find((existing) => existing.id === token.userId);
    return user && !user.confirmed && !user.deletedAt && isUsableConfirmationToken(token, time)
      ? { ...token } : null;
  }

  async confirmWithToken(hash, clock = () => new Date()) {
    const time = confirmationTime(clock());
    const normalized = normalizeTokenHash(hash);
    const token = normalized && this.confirmationTokens.get(normalized);
    if (!isUsableConfirmationToken(token, time)) return null;
    const index = this.users.findIndex((user) => user.id === token.userId);
    const user = this.users[index];
    if (!user || user.confirmed || user.deletedAt) return null;

    const confirmedUser = { ...user, confirmed: true, updatedAt: time };
    const tokens = new Map(this.confirmationTokens);
    for (const [tokenHash, existing] of tokens) {
      if (existing.userId === user.id && !existing.usedAt && !existing.revokedAt) {
        tokens.set(tokenHash, existing.id === token.id
          ? { ...existing, usedAt: time } : { ...existing, revokedAt: time });
      }
    }
    this.users[index] = confirmedUser;
    this.confirmationTokens = tokens;
    return { ...confirmedUser };
  }
}
