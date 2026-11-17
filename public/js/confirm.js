const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
window.history.replaceState(
  window.history.state,
  "",
  window.location.pathname + window.location.search
);

const card = document.querySelector("#confirmation-card");
const message = document.querySelector("#confirmation-message");

function showMessage(text, successful = false) {
  message.textContent = text;
  message.className = `form-message form-message-${successful ? "success" : "error"}`;
}

async function confirmAccount() {
  try {
    if (!token) {
      showMessage("El enlace está incompleto. Abre el enlace de confirmación que recibiste por correo.");
      return;
    }

    const response = await fetch("/api/auth/confirm", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token }),
      redirect: "error"
    });
    const data = await response.json().catch(() => null);

    if (response.status === 200 && data?.user?.active === true) {
      showMessage("Tu cuenta se ha confirmado correctamente. Ya puedes iniciar sesión.", true);
    } else if (response.status === 400 && data?.error?.code === "INVALID_CONFIRMATION_TOKEN") {
      showMessage("El enlace no es válido, ha caducado o ya se ha utilizado. Necesitas un nuevo enlace de confirmación.");
    } else {
      showMessage("No se ha podido confirmar la cuenta por un error del servidor. Vuelve a abrir el enlace de tu correo más tarde.");
    }
  } catch {
    showMessage("No se ha podido conectar con MacroLog. Vuelve a abrir el enlace de tu correo e inténtalo de nuevo.");
  } finally {
    card.setAttribute("aria-busy", "false");
  }
}

confirmAccount();
