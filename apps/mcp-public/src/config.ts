import { readIntEnv, readPortEnv, readTextEnv } from '@purple-skills/shared';

export const config = {
  port: readPortEnv('PORT', 3002),
  host: readTextEnv('HOST', '0.0.0.0'),
  /** Base do site, usada para montar a URL da página de uma skill pública. */
  siteBaseUrl: readTextEnv('SITE_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  /**
   * Endereço público deste servidor, base das URLs de download que as
   * ferramentas devolvem (`/skills/<skill>/download` na raiz,
   * `/virtual/<slug>/skills/<skill>/download` nos demais). Vazio = deduzido de
   * cada requisição (`proto://host`), o que só acerta quando o proxy repassa
   * os headers — atrás do Traefik do compose, ele repassa.
   */
  publicUrl: readTextEnv('MCP_PUBLIC_URL', '').replace(/\/+$/, ''),
  serverName: readTextEnv('MCP_SERVER_NAME', 'purple-skills'),
  version: readTextEnv('APP_VERSION', '1.0.0-beta.1'),
  /**
   * Janela em que um cliente conta como online no painel
   * (`docs/10-admin-canvas-e-sessoes.md`). Aqui ela agrupa as requisições
   * stateless de um mesmo cliente numa sessão só e presume o fim delas.
   */
  onlineWindowMs: readIntEnv('MCP_SESSION_ONLINE_WINDOW_MS', 120_000, { min: 1000 }),
};

/**
 * As variáveis do antigo MCP principal. Desde o `011` a raiz é o vMCP padrão
 * e quem decide o acesso é ele — aberto ou chaves `psv_` — então elas não têm
 * mais efeito nenhum.
 */
const LEGACY_AUTH_VARS = ['MCP_PUBLIC_AUTH', 'MCP_PUBLIC_KEY', 'MCP_PUBLIC_KEY_FILE'] as const;

/**
 * Trava de boot: recusa subir enquanto qualquer uma delas estiver definida.
 *
 * Ignorá-las com um aviso no log abriria em silêncio um servidor que o
 * operador protegia com `MCP_PUBLIC_KEY`: o backfill do `011` cria o vMCP
 * `public` **aberto**. Falhar alto obriga a ler a mensagem antes de o
 * servidor responder qualquer coisa — e a mensagem diz o que fazer.
 */
export function assertNoLegacyAuthEnv(env: NodeJS.ProcessEnv = process.env): void {
  const defined = LEGACY_AUTH_VARS.filter((name) => (env[name] ?? '').trim() !== '');
  if (defined.length === 0) return;

  throw new Error(
    `${defined.join(', ')} não ${defined.length === 1 ? 'existe' : 'existem'} mais: o MCP ` +
      'público é o MCP virtual padrão da instalação, e quem decide o acesso a /mcp é ele ' +
      '(aberto, ou chaves psv_ emitidas no painel). Se este servidor era protegido pela ' +
      'MCP_PUBLIC_KEY, antes de remover a variável do .env feche o MCP padrão ou emita chaves ' +
      'psv_ para ele no painel — o vMCP "public" criado na migração nasce aberto. ' +
      'Ver docs/09-mcp-padrao-e-skills-flutuantes.md.',
  );
}
