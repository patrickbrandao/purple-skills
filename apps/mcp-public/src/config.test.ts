import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `publicAuthMode` é lida uma vez por processo, então cada caso recarrega o
 * módulo com o ambiente que quer testar.
 */
async function modeWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { publicAuthMode } = await import('./config.js');
  return publicAuthMode();
}

afterEach(() => {
  delete process.env.MCP_PUBLIC_AUTH;
  delete process.env.MCP_PUBLIC_KEY;
  vi.restoreAllMocks();
});

describe('MCP_PUBLIC_AUTH', () => {
  // A regra que protege quem sobe de versão sem mexer no .env: o modo é o
  // que já existia, deduzido da presença da chave.
  it('sem a variável, deduz do que já existia: key com chave, open sem', async () => {
    expect(await modeWith({ MCP_PUBLIC_AUTH: undefined, MCP_PUBLIC_KEY: 'CHANGE_ME' })).toBe('key');
    expect(await modeWith({ MCP_PUBLIC_AUTH: undefined, MCP_PUBLIC_KEY: undefined })).toBe('open');
  });

  it('aceita os três valores e recusa o resto', async () => {
    expect(await modeWith({ MCP_PUBLIC_AUTH: 'managed', MCP_PUBLIC_KEY: undefined })).toBe('managed');
    expect(await modeWith({ MCP_PUBLIC_AUTH: 'KEY', MCP_PUBLIC_KEY: 'CHANGE_ME' })).toBe('key');
    await expect(modeWith({ MCP_PUBLIC_AUTH: 'fechado', MCP_PUBLIC_KEY: undefined })).rejects.toThrow(/inválida/);
  });

  it('key sem chave derruba o boot', async () => {
    await expect(modeWith({ MCP_PUBLIC_AUTH: 'key', MCP_PUBLIC_KEY: undefined })).rejects.toThrow(
      /exige MCP_PUBLIC_KEY/,
    );
  });

  it('open explícito com chave definida avisa e ignora', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await modeWith({ MCP_PUBLIC_AUTH: 'open', MCP_PUBLIC_KEY: 'CHANGE_ME' })).toBe('open');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ignorada/));
  });
});
