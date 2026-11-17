function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

export function buildConfirmationEmail(confirmationUrl) {
  if (typeof confirmationUrl !== "string" || !confirmationUrl.trim()) {
    throw new TypeError("La plantilla requiere un enlace de confirmación");
  }
  // El servicio valida el protocolo y el destino; la plantilla escapa ambos contextos HTML.
  const link = escapeHtml(confirmationUrl);
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirma tu cuenta de MacroLog</title>
  <style>
    @media only screen and (max-width: 600px) {
      .outer { padding: 20px 12px !important; }
      .content { padding: 28px 20px !important; }
      .action { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f3f6f5;font-family:Arial,Helvetica,sans-serif;color:#18342d;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f6f5;">
    <tr><td class="outer" align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #dce7e2;border-radius:16px;">
        <tr><td style="padding:28px 32px;border-bottom:1px solid #e5ede9;">
          <p style="margin:0;font-size:26px;font-weight:bold;letter-spacing:-1px;">MacroLog</p>
          <p style="margin:8px 0 0;font-size:12px;letter-spacing:1px;color:#537168;">CONFIRMACIÓN DE CUENTA</p>
        </td></tr>
        <tr><td class="content" style="padding:36px 32px;">
          <h1 style="margin:0 0 24px;font-size:28px;line-height:1.25;">Un paso más para empezar</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hola:</p>
          <p style="margin:0 0 28px;font-size:16px;line-height:1.6;">Gracias por registrarte en MacroLog. Confirma tu dirección de correo electrónico para activar tu cuenta.</p>
          <p style="margin:0 0 28px;">
            <a class="action" href="${link}" style="display:inline-block;padding:16px 28px;background-color:#176447;border-radius:8px;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;">Confirmar mi cuenta</a>
          </p>
          <p style="margin:0 0 20px;padding:16px;background-color:#edf5f0;border-radius:8px;font-size:14px;line-height:1.6;">Este enlace caduca a las <strong>24 horas</strong> de su emisión.</p>
          <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#537168;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
          <p style="margin:0 0 28px;font-size:13px;line-height:1.7;word-break:break-all;overflow-wrap:anywhere;"><a href="${link}" style="color:#176447;">${link}</a></p>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#537168;">Si no has solicitado este registro, puedes ignorar este mensaje.</p>
        </td></tr>
      </table>
      <p style="margin:24px 0 0;font-size:12px;color:#537168;">MacroLog · Tu alimentación, día a día.</p>
    </td></tr>
  </table>
</body>
</html>`;
}
