import type { RequestHandler } from 'express';
import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const criar = vi.hoisted(() => vi.fn());

// Só `createSkill` é trocado: o resto do pacote entra de verdade, e nada nele
// abre conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createSkill: criar,
}));

const { api } = await import('./api.js');

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };
};

/** O último handler da rota — depois dos guardas e do multer. */
function rota(method: string, path: string): RequestHandler {
  const layers = (api as unknown as { stack: Layer[] }).stack;
  const found = layers.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  if (!found?.route) throw new Error(`rota não registrada: ${method.toUpperCase()} ${path}`);
  return found.route.stack[found.route.stack.length - 1]!.handle;
}

function zipCom(skillMd: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf8'));
  return zip.toBuffer();
}

async function importar(skillMd: string, campos: Record<string, string> = {}) {
  const req = { file: { buffer: zipCom(skillMd), originalname: 'pacote.zip' }, body: campos };
  const res = { status: () => res, json: () => res };

  await rota('post', '/api/skills/import')(req as never, res as never, (() => {}) as never);
  await new Promise((resolve) => setImmediate(resolve));

  // A última chamada, não a primeira: um teste que importa mais de um .zip
  // compara cada resultado com a importação que acabou de fazer.
  return criar.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  // `skillMd` entra porque a rota passa o retorno por `bodyOnly` antes de
  // responder: sem ele cada importação despeja um TypeError no stderr do teste.
  criar.mockResolvedValue({ slug: 'minha-skill', skillMd: '', files: [] });
});

describe('POST /api/skills/import', () => {
  it('lê as flags de publicação do frontmatter do .zip', async () => {
    const input = await importar(
      '---\nname: minha-skill\nuse_as_prompt: true\nuse_as_resource: true\n---\n# Corpo\n',
    );

    expect(input).toMatchObject({ useAsPrompt: true, useAsResource: true });
  });

  // A porta da visibilidade é só o formulário: um .zip de terceiro pré-configura
  // as flags, mas elas ficam inertes até um admin publicar a skill.
  it('não deixa o .zip se autopublicar', async () => {
    const input = await importar(
      '---\nname: minha-skill\nis_public: true\nuse_as_prompt: true\n---\n# Corpo\n',
    );

    expect(input).toMatchObject({ isPublic: false, useAsPrompt: true });
  });

  it('sem nada no frontmatter, as flags vêm dos campos do formulário', async () => {
    const input = await importar('# Corpo\n', { useAsResource: 'true' });

    expect(input).toMatchObject({ useAsPrompt: false, useAsResource: true });
  });

  // `use_as_skill` é a única que nasce ligada: o .zip calado não a desliga, e
  // o desligamento vale venha ele do formulário ou do frontmatter.
  it('a superfície de ferramentas só é desligada por quem disser `false`', async () => {
    expect(await importar('# Corpo\n')).toMatchObject({ useAsSkill: true });

    expect(await importar('---\nname: a\nuse_as_skill: false\n---\n# Corpo\n')).toMatchObject({
      useAsSkill: false,
    });

    expect(await importar('# Corpo\n', { useAsSkill: 'false' })).toMatchObject({
      useAsSkill: false,
    });
  });
});
