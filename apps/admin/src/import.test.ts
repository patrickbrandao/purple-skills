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

  return criar.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  criar.mockResolvedValue({ slug: 'minha-skill', files: [] });
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
});
