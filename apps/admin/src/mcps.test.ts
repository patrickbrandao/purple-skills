/**
 * A permissão do canvas e dos vínculos de um vMCP no painel
 * (`docs/12-acesso-granular.md` §3.2 e decisões 6 e 7; `docs/10` §4.4).
 *
 * Os comportamentos que mais custariam caro se mudassem sem querer:
 *
 * 1. **o corte é `edit`, não "dono ou admin".** Arrastar um nó, ligar uma
 *    porta e acrescentar uma skill são ações de `edit`; nome, slug, abertura
 *    e chaves continuam em `manage`. Apertar isto para `manage` trancaria
 *    quem recebeu `edit` justamente para publicar; afrouxar para `view`
 *    entregaria publicação a quem só devia ler;
 * 2. **quem não alcança o nível recebe 403 com o motivo**, não uma falha
 *    calada: a mensagem diz o nível que a conta tem e o que a ação exige;
 * 3. **abrir um vMCP não pede confirmação**, nem com skill dentro: o
 *    `confirm_open` do `08` saiu no PR2 do `09` (decisão 9 e `§4.4`), e o que
 *    informa é o aviso inline do painel (`12`, decisão 15).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessLevel, type AccessLevel } from '@purple-skills/shared';
import type { AuthUser } from './auth.js';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { lerMcp, gravarCanvas, gravarSkills, atualizar, lerSkill } = vi.hoisted(() => ({
  lerMcp: vi.fn(),
  gravarCanvas: vi.fn(),
  gravarSkills: vi.fn(),
  atualizar: vi.fn(),
  lerSkill: vi.fn(),
}));

// Só as funções destes caminhos são trocadas: o resto do pacote entra de
// verdade (`AppError`, `notFound`, `badRequest`) e nada nele abre conexão em
// tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getVirtualMcp: lerMcp,
  setVirtualMcpCanvas: gravarCanvas,
  setVirtualMcpSkills: gravarSkills,
  updateVirtualMcp: atualizar,
  getSkillSummary: lerSkill,
}));

const { setCanvas, setSkills, update } = await import('./mcps.js');

const DONO = 'uuid-dono';

const sessao = (role: AuthUser['role'], uuid: string | null): AuthUser => ({
  uuid,
  email: uuid ? `${uuid}@exemplo.dev` : 'bootstrap',
  name: role,
  role,
  mustChangePassword: false,
  legacy: false,
});

const dono = sessao('editor', DONO);
const admin = sessao('admin', 'uuid-admin');
const convidado = sessao('membro', 'uuid-convidado');

/** A concessão que o banco encontraria para a conta convidada. */
let concedido: AccessLevel | null = null;

/**
 * O que a consulta com `viewer` devolveria (`docs/12` §3.1): o `access` sai do
 * mesmo `accessLevel` do `shared`, então admin e dono chegam aqui como `owner`.
 */
function mcpVisto(viewer: { role: AuthUser['role']; userUuid: string | null }) {
  return {
    uuid: 'uuid-mcp',
    slug: 'time-a',
    name: 'Time A',
    ownerUserUuid: DONO,
    isOpen: true,
    isActive: true,
    skills: [],
    catalogs: [],
    grants: [],
    access: accessLevel(viewer.role, DONO, viewer.userUuid === convidado.uuid ? concedido : null, viewer.userUuid),
  };
}

const CANVAS = { positions: [{ slug: 'alfa', x: 24, y: 48 }] };
const VINCULO = { skills: [{ slug: 'alfa', asSkill: true, asPrompt: false, asResource: false }] };

beforeEach(() => {
  vi.clearAllMocks();
  concedido = null;
  lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
    Promise.resolve(mcpVisto(options.viewer)),
  );
  lerSkill.mockResolvedValue({ slug: 'alfa', access: 'view' });
  gravarSkills.mockImplementation(() => Promise.resolve(mcpVisto({ role: 'admin', userUuid: 'uuid-admin' })));
  atualizar.mockImplementation(() => Promise.resolve(mcpVisto({ role: 'admin', userUuid: 'uuid-admin' })));
});

/** O `AppError` que a rota transforma em resposta. */
const recusa = async (acao: Promise<unknown>): Promise<{ status: number; message: string }> => {
  try {
    await acao;
  } catch (err: unknown) {
    const erro = err as { status: number; message: string };
    return { status: erro.status, message: erro.message };
  }
  throw new Error('a ação deveria ter sido recusada');
};

describe('permissão do canvas e dos vínculos (docs/12 §3.2)', () => {
  it('`edit` concedido move nós e vincula skill, mas não muda propriedades', async () => {
    concedido = 'edit';

    await setCanvas(convidado, 'time-a', CANVAS);
    expect(gravarCanvas).toHaveBeenCalledWith('uuid-mcp', expect.objectContaining({ positions: CANVAS.positions }));

    await setSkills(convidado, 'time-a', VINCULO);
    expect(gravarSkills).toHaveBeenCalledOnce();

    const erro = await recusa(update(convidado, 'time-a', { name: 'Outro nome' }));
    expect(erro.status).toBe(403);
    expect(erro.message).toContain('administrar');
    expect(atualizar).not.toHaveBeenCalled();
  });

  it('`view` só lê: recusa com 403 dizendo o nível que tem e o que falta', async () => {
    concedido = 'view';

    const canvas = await recusa(setCanvas(convidado, 'time-a', CANVAS));
    expect(canvas.status).toBe(403);
    expect(canvas.message).toContain('visualizar');
    expect(canvas.message).toContain('editar');
    expect(gravarCanvas).not.toHaveBeenCalled();

    expect((await recusa(setSkills(convidado, 'time-a', VINCULO))).status).toBe(403);
    expect(gravarSkills).not.toHaveBeenCalled();
  });

  it('sem concessão nenhuma, o vMCP não existe para a conta: 404', async () => {
    expect((await recusa(setCanvas(convidado, 'time-a', CANVAS))).status).toBe(404);
  });

  it('o dono e o admin não ficam trancados por lugar nenhum', async () => {
    for (const user of [dono, admin]) {
      await setCanvas(user, 'time-a', CANVAS);
      await setSkills(user, 'time-a', VINCULO);
      await update(user, 'time-a', { name: 'Outro nome' });
    }
    expect(gravarCanvas).toHaveBeenCalledTimes(2);
    expect(gravarSkills).toHaveBeenCalledTimes(2);
    expect(atualizar).toHaveBeenCalledTimes(2);
  });
});

/**
 * A confirmação de abertura existiu — `confirm_open_required` e `confirmOpen`
 * entraram com o `08` e saíram no PR2 do `09`, junto com o
 * `privateSkillCount`. Hoje abrir é uma caixa como outra qualquer (`09`
 * decisão 9), e quem informa é o painel (`12` decisão 15). O caso abaixo
 * existe para que ressuscitar a checagem no backend seja uma decisão, e não um
 * acidente de quem lê a `§3.3` do `08` sem a marca de revogação.
 */
describe('abrir um vMCP (docs/09 decisão 9)', () => {
  it('liga is_open sem confirmação, mesmo com skill vinculada', async () => {
    lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
      Promise.resolve({ ...mcpVisto(options.viewer), isOpen: false, skills: [{ slug: 'alfa' }] }),
    );

    await update(dono, 'time-a', { isOpen: true });

    expect(atualizar).toHaveBeenCalledWith('uuid-mcp', { isOpen: true }, 'web-admin', expect.objectContaining({ userUuid: DONO }));
  });
});
