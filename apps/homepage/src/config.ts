import { readPortEnv, readTextEnv } from '@purple-skills/shared';

/**
 * Configuração da homepage.
 *
 * Só o necessário para servir arquivos estáticos: a homepage não fala com o
 * banco nem com nenhum outro serviço, então não há URL de MCP ou de catálogo
 * para configurar aqui.
 */
export const config = {
  port: readPortEnv('PORT', 3004),
  host: readTextEnv('HOST', '0.0.0.0'),
  isProduction: process.env.NODE_ENV === 'production',
};
