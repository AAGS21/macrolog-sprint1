import { describe, expect, it } from "vitest";
import { buildConfirmationEmail } from "../../src/services/emailTemplates/confirmationEmail.js";

describe("Plantilla de confirmación de MacroLog", () => {
  it("presenta identidad, saludo, acción, alternativa, caducidad y aviso en español", () => {
    const url = "https://macrolog.example/confirm?token=fixture";
    const html = buildConfirmationEmail(url);
    for (const content of ["MacroLog", "Hola:", "Confirma tu dirección de correo electrónico", "Confirmar mi cuenta",
      "copia y pega este enlace", "24 horas", "Si no has solicitado este registro", "ignorar este mensaje"]) {
      expect(html).toContain(content);
    }
    expect(html.match(new RegExp(`href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"))).toHaveLength(2);
    expect(html).toContain(`>${url}</a>`);
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("@media only screen");
    expect(html).toContain("max-width:600px");
  });

  it("escapa el enlace tanto en href como en el texto visible", () => {
    const url = 'https://macrolog.example/confirm?token=a&next="test"&label=\'hola\'&value=<tag>';
    const escaped = "https://macrolog.example/confirm?token=a&amp;next=&quot;test&quot;&amp;label=&#39;hola&#39;&amp;value=&lt;tag&gt;";
    const html = buildConfirmationEmail(url);
    expect(html.split(`href="${escaped}"`)).toHaveLength(3);
    expect(html).toContain(`>${escaped}</a>`);
    expect(html).not.toContain(url);
    expect(html).not.toContain("<tag>");
  });

  it("impide inyección de etiquetas y atributos a través del enlace", () => {
    const html = buildConfirmationEmail('https://macrolog.example/?value="><img src=x onerror="alert(1)"><script>alert(1)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;script&gt;");
    expect(html.match(/<a\b/g)).toHaveLength(2);
  });

  it("escapa entidades preexistentes para impedir que se interpreten como comillas", () => {
    const html = buildConfirmationEmail("https://macrolog.example/?value=&quot;onclick=fixture");
    expect(html).toContain("&amp;quot;onclick=fixture");
    expect(html).not.toContain("&quot;onclick=fixture");
  });

  it.each([undefined, null, 123, {}, [], "", " "])("rechaza enlaces vacíos o de tipo incorrecto: %j", (url) => {
    expect(() => buildConfirmationEmail(url)).toThrow(TypeError);
  });
});
