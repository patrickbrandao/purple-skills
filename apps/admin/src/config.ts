import { scryptSync } from 'node:crypto';
import {
  assertNotPlaceholder,
  isBrandIconUrl,
  parseDomainList,
  readBoolEnv,
  readIntEnv,
  readPortEnv,
  readSecret,
  readTextEnv,
} from '@purple-skills/shared';

/**
 * Configuração do painel admin. Os segredos seguem o padrão
 * `<NOME>` / `<NOME>_FILE` (o arquivo tem prioridade).
 */
const siteName = readTextEnv('SITE_NAME', 'Purple Skills');

export const config = {
  port: readPortEnv('PORT', 3001),
  host: readTextEnv('HOST', '0.0.0.0'),
  siteBaseUrl: readTextEnv('SITE_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  siteName,
  /**
   * A marca do painel: o nome e o ícone no topo da sidebar, no login e na aba
   * do navegador. O nome acompanha `SITE_NAME` quando não é informado; o
   * ícone aceita URL http(s) ou caminho do próprio painel.
   */
  brandName: readTextEnv('ADMIN_BRAND_NAME', siteName),
  brandIconUrl: readBrandIconUrl(),
  /**
   * Endereço público do MCP público — base das URLs `/virtual/<slug>/mcp`
   * que o painel mostra no snippet de conexão de cada MCP virtual. Vazio = o
   * painel mostra o caminho e avisa que falta configurar.
   */
  mcpPublicUrl: readTextEnv('MCP_PUBLIC_URL', '').replace(/\/+$/, ''),
  /**
   * Links externos da sidebar do painel (`docs/10-admin-canvas-e-sessoes.md`).
   * Vazio some da tela; a documentação aponta para o GitHub por padrão.
   */
  docsUrl: readTextEnv('ADMIN_DOCS_URL', 'https://github.com/patrickbrandao/purple-skills#readme'),
  supportUrl: readTextEnv('ADMIN_SUPPORT_URL', ''),
  chatUrl: readTextEnv('ADMIN_CHAT_URL', ''),
  /**
   * Janela em que um cliente do MCP público conta como online: é o que o
   * contador do canvas e a lista de sessões usam (`docs/10`). O mcp-public lê
   * a mesma variável para agrupar as requisições stateless.
   */
  onlineWindowMs: readIntEnv('MCP_SESSION_ONLINE_WINDOW_MS', 120_000, { min: 1000 }),
  /** Versão mostrada em Configurações; vazia quando o ambiente não informa. */
  version: readTextEnv('APP_VERSION', ''),
  isProduction: process.env.NODE_ENV === 'production',
  /** Duração da sessão do painel, em segundos (padrão: 12h). */
  sessionTtlSeconds: readIntEnv('ADMIN_SESSION_TTL', 12 * 3600, { min: 60 }),
  /** Tamanho máximo de upload de .zip. */
  maxUploadBytes: readIntEnv('ADMIN_MAX_UPLOAD_BYTES', 64 * 1024 * 1024, { min: 1024 }),
  /**
   * Flag `Secure` do cookie de sessão. Por padrão acompanha o protocolo da
   * requisição (funciona tanto atrás de HTTPS quanto em HTTP local); pode ser
   * forçada com `ADMIN_COOKIE_SECURE=true|false` (também `1`/`0`, `yes`/`no`,
   * `on`/`off`, em qualquer caixa). Vazia = automático, e é por isso que o
   * valor fica `undefined`, e não `false`. Qualquer outro texto **derruba o
   * boot**: o leitor antigo devolvia `false` para tudo que não fosse `true`/`1`,
   * e um `TRUE` ou `yes` destravava em silêncio o cookie que o operador quis
   * travar — pior que não configurar nada, porque o automático teria travado.
   */
  cookieSecure: readBoolEnv('ADMIN_COOKIE_SECURE'),
  /**
   * Origens aceitas nas requisições de escrita do painel, além da própria
   * (comparada pelo `Host`, **com a porta**, e pela `ADMIN_PUBLIC_URL` — ver
   * `csrfGuard`). Cada entrada é uma origem inteira: esquema, nome e porta,
   * como `https://portal.exemplo.com:8443`; outra porta ou outro esquema do
   * mesmo nome não casam. Lista separada por vírgula; normalmente vazia, já
   * que o painel é sempre same-origin.
   */
  extraAllowedOrigins: (process.env.ADMIN_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  /**
   * Endereço público do próprio painel — usado para montar o `redirect_uri` do
   * OIDC e o link de redefinição de senha. Sem ele, o `redirect_uri` cai no
   * `Host` da requisição (o provedor ainda confere o valor registrado), e o
   * link de redefinição só aceita o `Host` quando o pedido vem de uma rede
   * interna — ver `resetLinkBaseUrl`. Também conta como origem própria na
   * checagem anti-CSRF (`csrfGuard`), para o proxy que publica o painel numa
   * porta que não repassa no `Host`.
   */
  publicUrl: readTextEnv('ADMIN_PUBLIC_URL', '').replace(/\/+$/, ''),

  // ------------------------------------------------------ rate limiting ----
  /** Tentativas erradas antes de travar a conta (`users.locked_until`). */
  loginMaxAttempts: readIntEnv('LOGIN_MAX_ATTEMPTS', 8, { min: 1, max: 1000 }),
  /** Duração da trava da conta, em segundos. */
  loginLockSeconds: readIntEnv('LOGIN_LOCK_SECONDS', 15 * 60, { min: 1 }),
  /** Teto de tentativas por IP na janela em memória (a camada de cima). */
  loginIpMaxAttempts: readIntEnv('LOGIN_IP_MAX_ATTEMPTS', 30, { min: 1 }),
  loginIpWindowSeconds: readIntEnv('LOGIN_IP_WINDOW_SECONDS', 5 * 60, { min: 1 }),

  // -------------------------------------------------------------- OIDC ----
  oidcIssuer: readTextEnv('OIDC_ISSUER', ''),
  oidcClientId: readTextEnv('OIDC_CLIENT_ID', ''),
  oidcProviderName: readTextEnv('OIDC_PROVIDER_NAME', 'SSO'),
  oidcScopes: readTextEnv('OIDC_SCOPES', 'openid email profile'),
  /**
   * Domínios de e-mail autorizados. **Vazia recusa todo login por SSO**, não só
   * o auto-provisionamento: `resolveOidcUser` confere a allowlist antes de
   * procurar a conta, então nem quem já está vinculado entra — sobra o login
   * local. É a falha fechada da §2.4: sem allowlist, qualquer conta do provedor
   * viraria `membro` do catálogo. Para SSO sem criar conta nova, o ajuste é
   * `OIDC_AUTO_PROVISION=false`, com esta lista preenchida.
   */
  oidcAllowedDomains: parseDomainList(process.env.OIDC_ALLOWED_DOMAINS),
  oidcAutoProvision: readBoolEnv('OIDC_AUTO_PROVISION') ?? true,

  // -------------------------------------------------------------- SMTP ----
  smtpFrom: readTextEnv('SMTP_FROM', ''),
  /** Validade do link de redefinição de senha, em segundos (padrão: 1h). */
  resetTtlSeconds: readIntEnv('PASSWORD_RESET_TTL', 3600, { min: 60 }),
};

export const SESSION_COOKIE = 'ps_admin';
/** Cookie de estado do OIDC (nonce + PKCE + destino), curto e httpOnly. */
export const OIDC_COOKIE = 'ps_oidc';

/**
 * OIDC só liga com issuer, client id e client secret presentes.
 * Faltando qualquer um, o botão nem aparece no painel.
 */
export function oidcEnabled(): boolean {
  return Boolean(config.oidcIssuer && config.oidcClientId && readSecret('OIDC_CLIENT_SECRET'));
}

export function oidcClientSecret(): string {
  const value = readSecret('OIDC_CLIENT_SECRET');
  if (!value) throw new Error('OIDC_CLIENT_SECRET ausente');
  return value;
}

/** SMTP é opcional: sem ele, o reset de senha passa a ser feito pelo admin. */
export function smtpUrl(): string | undefined {
  return readSecret('SMTP_URL');
}

export const smtpEnabled = (): boolean => Boolean(smtpUrl() && config.smtpFrom);

let adminPassword: string | null | undefined;
let sessionSecret: string | null = null;

/**
 * Senha de bootstrap.
 *
 * Deixou de ser obrigatória: ela só serve para criar o **primeiro** admin em
 * `/api/setup`. Depois que existe uma conta, o painel recusa esse caminho e a
 * variável fica inerte (`docs/05-accounts-and-roles.md` §2.3).
 *
 * Enquanto vale, ela **é** a credencial que cria o primeiro administrador — e
 * ainda é a semente do segredo de sessão quando `ADMIN_SESSION_SECRET` falta.
 * Por isso o placeholder é recusado aqui. Só quem chega a este ponto é
 * atingido: com uma conta já criada, o `/api/setup` responde 404 e o login
 * legado 401 antes de consultar a senha, então um `CHANGE_ME` esquecido no
 * `.env` de uma instalação em uso continua inerte, sem derrubar o boot.
 */
export function getAdminPassword(): string | null {
  if (adminPassword === undefined) adminPassword = readSecret('ADMIN_PASSWORD') ?? null;
  return adminPassword === null ? null : assertNotPlaceholder('ADMIN_PASSWORD', adminPassword);
}

/**
 * Segredo de assinatura da sessão.
 *
 * Quando `ADMIN_SESSION_SECRET` não é informado, o segredo é derivado da senha
 * com **scrypt**, não por concatenação direta. A diferença importa: o cookie é
 * `payload.HMAC-SHA256(segredo, payload)` com payload conhecido, então um cookie
 * capturado vira um oráculo offline. Com o segredo sendo a senha crua, testar
 * candidatos custa um HMAC (bilhões por segundo em GPU) e a senha do painel cai
 * junto. Com scrypt, cada tentativa custa memória e dezenas de milissegundos.
 *
 * A propriedade útil da derivação é preservada: trocar a senha invalida as
 * sessões antigas. Ainda assim, prefira definir o segredo explicitamente em
 * produção — `openssl rand -hex 32`. Com contas, a derivação a partir da senha
 * de bootstrap perde sentido: defina o segredo.
 *
 * O salt da derivação é constante e público, o que permitiria pré-computar uma
 * tabela válida para todas as instalações do projeto. A derivação continua
 * existindo porque removê-la derrubaria quem hoje sobe só com `ADMIN_PASSWORD`,
 * e um salt por instalação teria de vir do banco — que este módulo não acessa.
 * O que fecha o ataque barato é a recusa do placeholder: sem um
 * `ADMIN_PASSWORD` público, não há entrada conhecida para pré-computar.
 */
export function getSessionSecret(): string {
  if (sessionSecret) return sessionSecret;

  const configured = readSecret('ADMIN_SESSION_SECRET');
  if (configured) {
    // O placeholder do `.env.example` é público: aceitá-lo deixaria qualquer
    // pessoa assinar o cookie de sessão, que é a única fonte de verdade da
    // autenticação do painel (sessão stateless, sem tabela de sessões).
    sessionSecret = assertNotPlaceholder('ADMIN_SESSION_SECRET', configured);
    return sessionSecret;
  }

  const password = getAdminPassword();
  if (!password) {
    throw new Error(
      'Defina ADMIN_SESSION_SECRET (openssl rand -hex 32). Sem ele o cookie de ' +
        'sessão só pode ser derivado de ADMIN_PASSWORD, que também está ausente.',
    );
  }

  if (config.isProduction) {
    console.warn(
      '[admin] ADMIN_SESSION_SECRET não definido: derivando da senha de bootstrap. ' +
        'Defina um segredo próprio (openssl rand -hex 32) — ele sobrevive à ' +
        'remoção da ADMIN_PASSWORD.',
    );
  }

  // N=2^15 com r=8 usa ~32 MB e ~100 ms — roda uma única vez por processo.
  sessionSecret = scryptSync(password, 'purple-skills:admin-session:v1', 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString('base64url');

  return sessionSecret;
}

/** Base pública do painel, com fallback no `Host` da requisição. */
export function panelBaseUrl(proto: string, host: string): string {
  return config.publicUrl || `${proto}://${host}`;
}

/**
 * `true` para os endereços que o `TRUST_PROXY` padrão já trata como internos
 * (`loopback, uniquelocal`): 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12,
 * 192.168.0.0/16 e fc00::/7. Fora dessas faixas, a requisição atravessou uma
 * rede que esta instalação não controla.
 */
export function isInternalAddress(ip: string | undefined): boolean {
  if (!ip) return false;

  // Socket dual-stack entrega IPv4 mapeado (`::ffff:172.18.0.1`): o que
  // interessa classificar é o IPv4 de dentro.
  const value = ip.trim().toLowerCase().replace(/^::ffff:/, '');

  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(value);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first === 127 || first === 10) return true;
    if (first === 172) return second >= 16 && second <= 31;
    return first === 192 && second === 168;
  }

  if (value === '::1') return true;
  // fc00::/7 são os prefixos `fc` e `fd`. O primeiro hexteto sempre aparece com
  // os quatro dígitos, porque começa por um dígito diferente de zero.
  return /^f[cd][0-9a-f]{2}:/.test(value);
}

/**
 * Base do link de redefinição de senha — o único endereço do painel que sai por
 * e-mail. `null` significa "não há base confiável": a rota falha fechada em vez
 * de montar o link.
 *
 * Aqui o `Host` não pode ser fallback cego como no `panelBaseUrl`. Quem pede a
 * redefinição é qualquer visitante, e o link chega à caixa de **outra** pessoa:
 * deduzir o domínio do `Host` deixaria quem pede escolher o servidor que recebe
 * o token da vítima — e ele viaja na querystring, então basta o clique. No
 * `redirect_uri` do OIDC o mesmo truque não paga, porque o provedor compara com
 * o endereço registrado; neste caminho não existe segunda conferência.
 *
 * Exigir `ADMIN_PUBLIC_URL` sempre travaria quem sobe a stack sem configurar
 * nada, então o `Host` continua valendo quando o pedido vem de uma rede interna
 * (`isInternalAddress`) — o caso do `docker compose up` publicado em 127.0.0.1 e
 * do acesso pela LAN. Exposta na Internet sem a variável, a rota responde 503 e
 * a redefinição volta a ser feita por um administrador (§2.6).
 */
export function resetLinkBaseUrl(
  proto: string,
  host: string | undefined,
  ip: string | undefined,
): string | null {
  if (config.publicUrl) return config.publicUrl;
  if (!host || !isInternalAddress(ip)) return null;
  return `${proto}://${host}`;
}

/** Valor inválido derruba o boot, em vez de virar um ícone quebrado em silêncio. */
function readBrandIconUrl(): string {
  const value = readTextEnv('ADMIN_BRAND_ICON_URL', '/assets/images/purple-hat-256.png');
  if (!isBrandIconUrl(value)) {
    throw new Error('ADMIN_BRAND_ICON_URL precisa ser uma URL http(s) ou um caminho que comece com "/"');
  }
  return value;
}
