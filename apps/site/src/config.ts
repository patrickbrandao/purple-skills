import { readPortEnv, readTextEnv } from '@purple-skills/shared';

/** Base sem barra final + `/mcp`; string vazia continua vazia. */
function mcpBaseUrl(value: string): string {
  const base = value.replace(/\/+$/, '');
  return base ? `${base}/mcp` : '';
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
  siteTagline: readTextEnv('SITE_TAGLINE', 'Catálogo aberto de skills para agentes de IA'),
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
  mcpAdminUrl: readTextEnv('MCP_ADMIN_URL', '').replace(/\/+$/, ''),
  adminUrl: readTextEnv('ADMIN_URL', '').replace(/\/+$/, ''),
  isProduction: process.env.NODE_ENV === 'production',
};
