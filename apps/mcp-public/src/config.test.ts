import { describe, expect, it } from 'vitest';
import { assertNoLegacyAuthEnv } from './config.js';

/**
 * As variáveis do antigo MCP principal não têm mais efeito: a raiz é o vMCP
 * padrão. Deixá-las passar com um aviso abriria em silêncio um servidor que
 * o operador protegia, porque o `public` do backfill nasce aberto — daí a
 * trava de boot.
 */
describe('trava de boot das variáveis do antigo MCP principal', () => {
  it('sobe quando nenhuma delas está definida, ou estão vazias', () => {
    expect(() => assertNoLegacyAuthEnv({})).not.toThrow();
    expect(() =>
      assertNoLegacyAuthEnv({ MCP_PUBLIC_AUTH: '', MCP_PUBLIC_KEY: '  ', MCP_PUBLIC_KEY_FILE: '' }),
    ).not.toThrow();
  });

  it.each(['MCP_PUBLIC_AUTH', 'MCP_PUBLIC_KEY', 'MCP_PUBLIC_KEY_FILE'])(
    'recusa subir com %s definida e diz o que fazer',
    (name) => {
      expect(() => assertNoLegacyAuthEnv({ [name]: 'x' })).toThrow(
        new RegExp(`${name}.*não existe mais.*Configura|${name}.*painel`),
      );
    },
  );

  it('nomeia todas as que encontrou', () => {
    expect(() => assertNoLegacyAuthEnv({ MCP_PUBLIC_AUTH: 'open', MCP_PUBLIC_KEY: 'k' })).toThrow(
      /MCP_PUBLIC_AUTH, MCP_PUBLIC_KEY não existem mais/,
    );
  });
});
