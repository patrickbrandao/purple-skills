import { createHash } from 'node:crypto';

/**
 * Cabeçalhos de segurança das páginas dos três frontends (site, homepage e
 * painel). Um lugar só: as três SPAs são Vite + React + Tailwind e compartilham
 * o mesmo desenho, então manter três políticas divergentes seria garantir que
 * uma delas ficasse desatualizada.
 *
 * O ponto delicado é a `Content-Security-Policy`. Cada `index.html` traz um
 * `<script>` embutido que escolhe o tema antes da primeira pintura (para não
 * piscar branco no modo escuro) — e o Vite copia esse bloco para o
 * `dist-web/index.html` sem minificar. Em vez de fixar um hash no código (que
 * se desatualiza calado a cada vírgula mexida no HTML, derrubando o tema em
 * produção sem ninguém notar), o hash é calculado no boot a partir do HTML que
 * o app realmente serve: `inlineScriptHashes`. Não há como divergir.
 *
 * Duas frouxuras são deliberadas e estão documentadas em cada diretiva abaixo:
 * `style-src 'unsafe-inline'` e `img-src` aberto a http(s).
 */

/** `Referrer-Policy` do site e da homepage: origem, nunca o caminho, para fora. */
export const REFERRER_POLICY_PUBLIC = 'strict-origin-when-cross-origin';

/** `Referrer-Policy` do painel: nada sai daqui, nem a origem. */
export const REFERRER_POLICY_PRIVATE = 'same-origin';

/** Folha de estilo do Google Fonts — o `<link>` dos três `index.html`. */
export const GOOGLE_FONTS_STYLE = 'https://fonts.googleapis.com';

/** Os arquivos `.woff2` que aquela folha referencia. */
export const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';

export type SecurityHeadersOptions = {
  /**
   * O `index.html` servido como documento. De cada `<script>` sem `src` sai um
   * hash para o `script-src`. Ausente (build de web não encontrado), o app não
   * serve documento nenhum e o `script-src` fica só com `'self'`.
   */
  html?: string;
  /** Padrão: `REFERRER_POLICY_PUBLIC`. */
  referrerPolicy?: string;
  /** Origens extras de folha de estilo (Google Fonts, nos três apps). */
  styleSources?: string[];
  /** Origens extras de arquivo de fonte. */
  fontSources?: string[];
  /** Origens extras de imagem. */
  imgSources?: string[];
  /** Origens extras de `fetch`/`XHR`/`sendBeacon`. */
  connectSources?: string[];
  /** Quem pode embutir a página em `<iframe>`. Padrão: `'none'`. */
  frameAncestors?: string;
  /**
   * `true` envia a política em `Content-Security-Policy-Report-Only`: o
   * navegador reclama no console e não bloqueia nada. Serve para conferir uma
   * diretiva nova numa instalação real antes de ligá-la de verdade.
   */
  reportOnly?: boolean;
};

/**
 * Os hashes `'sha256-…'` dos `<script>` embutidos no HTML, na ordem em que
 * aparecem e sem repetir.
 *
 * O hash da CSP é sobre o texto do script exatamente como está no documento —
 * espaços e quebras de linha inclusive —, por isso nada é aparado aqui.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  // `(?![^>]*\bsrc\s*=)`: script com `src` é arquivo externo, coberto por `'self'`.
  const inline = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(inline)) {
    const body = match[1];
    if (!body) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

/** Monta a política. Exportada para quem só quer o valor do cabeçalho. */
export function contentSecurityPolicy(options: SecurityHeadersOptions = {}): string {
  const { html, styleSources = [], fontSources = [], imgSources = [], connectSources = [] } = options;

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${options.frameAncestors ?? "'none'"}`,
    // Todo formulário das SPAs é enviado por `fetch`, para a própria origem.
    "form-action 'self'",
    // O script de tema entra pelo hash; o bundle do Vite, por `'self'`.
    ['script-src', "'self'", ...(html ? inlineScriptHashes(html) : [])].join(' '),
    // `'unsafe-inline'` é necessário, não folga: o `cmdk` da paleta de comandos
    // usa o Radix, que injeta um `<style>` em runtime para travar o scroll
    // (`react-style-singleton`). Sem isso a paleta — a superfície primária de
    // ação do painel — quebraria calada em produção. O Tailwind v4 também
    // injeta estilo em desenvolvimento.
    ['style-src', "'self'", "'unsafe-inline'", ...styleSources].join(' '),
    // `data:` pelos ícones SVG embutidos no CSS; http(s) porque o ícone de uma
    // skill e o da marca do painel são URLs quaisquer (`isValidSkillIcon`), e
    // o SKILL.md renderizado pode trazer imagem de fora.
    ['img-src', "'self'", 'data:', 'https:', 'http:', ...imgSources].join(' '),
    ['font-src', "'self'", 'data:', ...fontSources].join(' '),
    // As três SPAs falam só com a própria origem: não há `VITE_*` de API.
    ['connect-src', "'self'", ...connectSources].join(' '),
  ].join('; ');
}

/**
 * O conjunto de cabeçalhos a aplicar em toda resposta do app. Calcule uma vez
 * no boot — é função pura do HTML — e repasse com `res.setHeader`.
 *
 * Rotas que servem conteúdo de terceiros (arquivo de skill) sobrescrevem a CSP
 * com a sua, bem mais fechada (`default-src 'none'; sandbox`); `setHeader`
 * substitui, então a ordem não importa.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): Record<string, string> {
  const policy = contentSecurityPolicy(options);
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': options.referrerPolicy ?? REFERRER_POLICY_PUBLIC,
    // `frame-ancestors` cobre o mesmo, mas o cabeçalho antigo ainda é o que
    // alguns proxies e scanners conferem.
    'X-Frame-Options': 'DENY',
    // Janela aberta por `window.open` fica sem `opener`: uma aba externa não
    // consegue mexer nesta. Nada aqui depende de conversar com o abridor.
    'Cross-Origin-Opener-Policy': 'same-origin',
    [options.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy']: policy,
  };
}
