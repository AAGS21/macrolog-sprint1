const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const EMAIL_LOCAL_PART = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const EMAIL_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function normalizeEmail(value) {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return null;
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2 || email.length > 254) return null;
  const [local, domain] = parts;
  return local.length <= 64 && EMAIL_LOCAL_PART.test(local) && EMAIL_DOMAIN.test(domain) &&
    !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") ? email : null;
}
