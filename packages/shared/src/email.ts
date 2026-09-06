/**
 * Normalização e validação de e-mail.
 *
 * A unicidade no banco é por `lower(email)`; normalizar aqui evita que a
 * mesma pessoa vire duas contas por causa da caixa. A validação é
 * deliberadamente frouxa — a RFC 5322 aceita coisas que nenhum validador
 * regex cobre, e recusar um endereço válido é pior do que aceitar um inválido
 * que simplesmente nunca receberá e-mail.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;

  return email;
}

/** Domínio do endereço, já em caixa baixa. `null` se o e-mail for inválido. */
export function emailDomain(raw: unknown): string | null {
  const email = normalizeEmail(raw);
  if (!email) return null;
  return email.slice(email.lastIndexOf('@') + 1);
}

/**
 * Allowlist de domínios do OIDC (`OIDC_ALLOWED_DOMAINS`).
 *
 * Lista **vazia recusa tudo**, de propósito: é o que faz uma instalação mal
 * configurada falhar fechada em vez de abrir o catálogo privado a qualquer
 * conta do provedor (`docs/05-accounts-and-roles.md` §2.4).
 */
export function emailInDomains(email: string, domains: readonly string[]): boolean {
  const domain = emailDomain(email);
  if (!domain || domains.length === 0) return false;
  return domains.some((allowed) => {
    const candidate = allowed.trim().toLowerCase().replace(/^@/, '');
    if (!candidate) return false;
    return domain === candidate || domain.endsWith(`.${candidate}`);
  });
}

export function parseDomainList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}
