import { loginUser, resendConfirmation } from "./apiClient.js";
import {
  destinationForUser,
  redirectIfAuthenticated
} from "./session.js";

const form = document.querySelector("#login-form");
const message = document.querySelector("#form-message");
const successMessage =
  document.querySelector("#success-message");
const submitButton = document.querySelector("#submit-button");
const resendButton = document.querySelector("#resend-confirmation-button");
const emailInput = document.querySelector("#email");

const parameters = new URLSearchParams(window.location.search);

if (parameters.get("registered") === "pending") {
  successMessage.textContent =
    "Cuenta creada correctamente. Revisa tu correo electrónico y confirma tu cuenta antes de iniciar sesión.";
  resendButton.classList.remove("hidden");
}

redirectIfAuthenticated();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const email = formData.get("email");
  const password = formData.get("password");

  message.textContent = "";
  message.className = "form-message";
  submitButton.disabled = true;
  submitButton.textContent = "Iniciando sesión...";

  try {
    const result = await loginUser(email, password);
    window.location.replace(destinationForUser(result.user));
  } catch (error) {
    if (error.code === "ACCOUNT_PENDING") {
      resendButton.classList.remove("hidden");
    }
    message.textContent = error.message;
    message.classList.add("form-message-error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Iniciar sesión";
  }
});

resendButton.addEventListener("click", async () => {
  if (resendButton.disabled || !emailInput.reportValidity()) return;

  resendButton.disabled = true;
  message.textContent = "";
  message.className = "form-message";

  try {
    const result = await resendConfirmation(emailInput.value);
    message.textContent = result.message;
    message.classList.add("form-message-success");
  } catch (error) {
    message.textContent = error.status === 429
      ? "Demasiadas solicitudes. Inténtalo de nuevo más tarde."
      : "No se ha podido solicitar el correo de confirmación. Inténtalo de nuevo más tarde.";
    message.classList.add("form-message-error");
  } finally {
    resendButton.disabled = false;
  }
});
