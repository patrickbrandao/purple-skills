import { readPortEnv, readTextEnv } from '@purple-skills/shared';

/** Base sem barra final + `/mcp`; string vazia continua vazia. */
function mcpBaseUrl(value: string): string {
  const base = value.replace(/\/+$/, '');
  return base ? `${base}/mcp` : '';
}

/**
 * `SITE_CORS_ORIGIN` na forma que o `cors()` recebe: `*` é qualquer origem;
 * o resto é uma origem, ou uma lista separada por vírgula.
 */
export function corsOrigins(value: string): '*' | string[] {
  return value === '*' ? '*' : value.split(',').map((origem) => origem.trim());
}

/**
 * Configuração do site público, lida do ambiente.
 *
 * `readTextEnv` em vez de `??`: o compose repassa variáveis não preenchidas
 * como string vazia, que apagaria o valor em vez de usar o padrão.
 */
export const config = {
  port: readPortEnv('PORT', 3000),
  host: readTextEnv('HOST', '0.0.0.0'),
  siteBaseUrl: readTextEnv('SITE_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  siteName: readTextEnv('SITE_NAME', 'Purple Skills'),
  siteTagline: readTextEnv('SITE_TAGLINE', 'Skills abertas para agentes de IA'),
  // URLs mostradas na seção "Endereços de acesso". Vazias = o endereço não é
  // divulgado nesta instalação, e o cartão correspondente some da página.
  //
  // MCP_PUBLIC_URL é a BASE (sem `/mcp`): é a mesma variável que o admin usa
  // para montar `<base>/virtual/<slug>/mcp` e que o mcp-public usa para as
  // URLs de download. O servidor MCP principal sempre monta sua rota em
  // `<base>/mcp` (ver apps/mcp-public/src/http.ts), então o endereço completo
  // mostrado aqui precisa acrescentar esse sufixo — a variável em si nunca o
  // contém, senão o painel duplicaria "mcp" ao montar os MCPs virtuais.
  mcpPublicUrl: mcpBaseUrl(readTextEnv('MCP_PUBLIC_URL', '')),
  /** A mesma base, crua: monta `<base>/virtual/<slug>/mcp` na lista de MCPs abertos. */
  mcpPublicBaseUrl: readTextEnv('MCP_PUBLIC_URL', '').replace(/\/+$/, ''),
  // MCP_ADMIN_URL e ADMIN_URL são o contrário: o endereço COMPLETO, e saem
  // crus de propósito (só a barra final cai). Não servem de base para mais
  // nada — só são exibidos: o cartão, o rodapé e o `mcp.json` copiável de
  // "Administre pelo agente". Por isso a do MCP administrativo já vem com o
  // caminho do transporte que o operador quer divulgar, normalmente `/mcp`
  // (`https://mcp-admin.example.com/mcp`); o mcp-admin tem três (`/mcp`,
  // `/mcp/stateless` e `/sse`), e acrescentar `/mcp` aqui adivinharia um deles
  // e duplicaria o sufixo de quem já preenche certo. Sem caminho, o `mcp.json`
  // copiado faz `POST /` e o mcp-admin responde 404 "Rota não encontrada".
  mcpAdminUrl: readTextEnv('MCP_ADMIN_URL', '').replace(/\/+$/, ''),
  adminUrl: readTextEnv('ADMIN_URL', '').replace(/\/+$/, ''),
  // Origens aceitas na API pública (`*` = qualquer uma, o padrão). Duas
  // superfícies leem o valor: o `cors()` do `index.ts` e o `/api/meta`, para o
  // cartão "API REST pública" da home dizer o que ESTA instalação faz, e não
  // o padrão do projeto.
  corsOrigin: corsOrigins(readTextEnv('SITE_CORS_ORIGIN', '*')),
  isProduction: process.env.NODE_ENV === 'production',
};
