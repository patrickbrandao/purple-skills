import { readPortEnv, readTextEnv } from '@purple-skills/shared';

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
  mcpPublicUrl: readTextEnv('MCP_PUBLIC_URL', '').replace(/\/+$/, ''),
  mcpAdminUrl: readTextEnv('MCP_ADMIN_URL', '').replace(/\/+$/, ''),
  adminUrl: readTextEnv('ADMIN_URL', '').replace(/\/+$/, ''),
  isProduction: process.env.NODE_ENV === 'production',
};
