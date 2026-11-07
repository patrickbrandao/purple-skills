/**
 * O motivo de um login por SSO recusado. O callback grava o texto no cookie
 * `ps_sso_error`, que dura um minuto, e manda para `/?sso_error=1`: na URL vai
 * só o marcador. **Era**, até a auditoria de 2026-11-07 (relatório 019), o texto
 * na querystring — e qualquer link forjado exibia a frase que quisesse como
 * erro oficial do painel. Um site terceiro não grava cookie neste domínio.
 */
export const SSO_ERROR_COOKIE = 'ps_sso_error';

/** O que a tela diz quando o marcador chega sem o cookie (link forjado, cookie vencido). */
export const SSO_ERROR_GENERICO =
  'Não foi possível entrar pelo SSO. Tente de novo ou fale com um administrador.';

/** Lê o motivo de uma string `document.cookie`; sem o cookie, o texto genérico. */
export function erroDoSso(cookies: string): string {
  for (const parte of cookies.split(';')) {
    const igual = parte.indexOf('=');
    if (igual < 0 || parte.slice(0, igual).trim() !== SSO_ERROR_COOKIE) continue;
    try {
      const texto = decodeURIComponent(parte.slice(igual + 1).trim());
      // O servidor manda frases curtas; um valor enorme não veio dele.
      if (texto && texto.length <= 500) return texto;
    } catch {
      // `%` solto: não foi o servidor que escreveu.
    }
  }
  return SSO_ERROR_GENERICO;
}

/** Lê o motivo e apaga o cookie, para ele não reaparecer num recarregamento. */
export function lerErroDoSso(): string {
  const texto = erroDoSso(document.cookie);
  document.cookie = `${SSO_ERROR_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  return texto;
}
