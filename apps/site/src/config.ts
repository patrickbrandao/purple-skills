/** Configuração do site público, lida do ambiente. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  siteBaseUrl: (process.env.SITE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  siteName: process.env.SITE_NAME ?? 'Purple Skills',
  siteTagline:
    process.env.SITE_TAGLINE ?? 'Catálogo aberto de skills para agentes de IA',
  mcpPublicUrl: (process.env.MCP_PUBLIC_URL ?? '').replace(/\/+$/, ''),
  isProduction: process.env.NODE_ENV === 'production',
};
