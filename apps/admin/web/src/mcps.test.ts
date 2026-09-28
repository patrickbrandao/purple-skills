import { describe, expect, it } from 'vitest';
// O texto do arquivo, sem avaliar nada — a mesma técnica de `audit.test.ts`:
// este bundle é de navegador e não importa `@purple-skills/shared` em valor.
import fonteDoShared from '../../../../packages/shared/src/types.ts?raw';
import { VIRTUAL_MCP_INSTRUCTIONS_MAX } from './api.js';

describe('espelho do teto das instruções do vMCP', () => {
  it('o painel conta até o mesmo número que o shared (e o CHECK do banco)', () => {
    const doShared = /^export const VIRTUAL_MCP_INSTRUCTIONS_MAX = (\d+);$/m.exec(fonteDoShared);
    if (!doShared) throw new Error('VIRTUAL_MCP_INSTRUCTIONS_MAX não encontrado no shared — o formato do arquivo mudou');

    expect(VIRTUAL_MCP_INSTRUCTIONS_MAX).toBe(Number(doShared[1]));
  });
});
