import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { Router, type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * As rotas de download do mcp-public, pelo Express de verdade.
 *
 * O despacho faz parte do que se testa: nenhuma rota registra `head`, e o
 * Express 5 manda o `HEAD` para o handler de `GET` (`router/lib/route.js`). Por
 * isso estes testes sobem o roteador numa porta e pedem por `fetch` — chamar o
 * handler direto, com um `req` falso, não provaria nada sobre o método.
 */

const db = vi.hoisted(() => ({
  getSkillSummary: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  recordSkillAccess: vi.fn(async () => undefined),
}));

vi.mock('@purple-skills/db', () => db);

const { registrarDownloads } = await import('./downloads.js');

const SKILL = {
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  tags: ['git'],
};

const ARQUIVOS = [
  { relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 13, isText: true },
  { relativePath: 'ref/extra.md', mimeType: 'text/markdown', sizeBytes: 5, isText: true },
];

const CONTEUDO: Record<string, string> = { 'SKILL.md': '# Minha Skill', 'ref/extra.md': 'extra' };

/** O `auth` do ponto de montagem: aqui só põe o vMCP aberto na requisição. */
const auth: RequestHandler = (req, _res, next) => {
  req.virtual = {
    mcp: { uuid: 'mcp-1', slug: 'public', name: 'Public', description: '', isOpen: true },
    identity: 'virtual:mcp-1:open',
  } as never;
  next();
};

let running: Server | undefined;

function subir(): Promise<string> {
  const app = express();
  const router = Router({ mergeParams: true });
  registrarDownloads(auth)(router);
  app.use(router);

  return new Promise((resolve) => {
    running = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(running!.address() as AddressInfo).port}`);
    });
  });
}

/** O registro é disparado fora do caminho da resposta: dá a ele a vez de rodar. */
const registroAssentou = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.clearAllMocks();
  db.getSkillSummary.mockResolvedValue(SKILL);
  db.listFiles.mockResolvedValue(ARQUIVOS);
  db.readFile.mockImplementation(async (_uuid: string, path: string) =>
    path in CONTEUDO
      ? { relativePath: path, mimeType: 'text/markdown', sizeBytes: 5, isText: true, buffer: Buffer.from(CONTEUDO[path]!) }
      : null,
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
  running = undefined;
});

/**
 * `HEAD` é "só me diga o que teria aí": `wget --spider`, o gerenciador de
 * download que pergunta nome e tamanho antes do `GET`, o monitor de
 * disponibilidade. Contá-lo gravava linha permanente em `skill_accesses`, somava
 * no score que ordena a vitrine — e, no pacote, lia e comprimia a skill inteira
 * para jogar fora, sem a contrapressão de um corpo que ninguém recebe
 * (relatório 066 da auditoria de 2026-09-19).
 */
describe('HEAD nas rotas de download', () => {
  it.each([['download'], ['download.skill']])(
    'HEAD /skills/:skill/%s devolve os cabeçalhos do pacote sem gerar o pacote nem contar download',
    async (rota) => {
      const base = await subir();

      const res = await fetch(`${base}/skills/minha-skill/${rota}`, { method: 'HEAD' });
      await registroAssentou();

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="minha-skill.${rota === 'download' ? 'zip' : 'skill'}"`,
      );
      expect(res.headers.get('cache-control')).toBe('no-store');
      // Nem a lista de arquivos: o pacote não chega a começar.
      expect(db.listFiles).not.toHaveBeenCalled();
      expect(db.readFile).not.toHaveBeenCalled();
      expect(db.recordSkillAccess).not.toHaveBeenCalled();
    },
  );

  it('HEAD no SKILL.md avulso não conta visualização', async () => {
    const base = await subir();

    const res = await fetch(`${base}/skills/minha-skill/files/SKILL.md`, { method: 'HEAD' });
    await registroAssentou();

    expect(res.status).toBe(200);
    // Os cabeçalhos são os do GET, com o tamanho do SKILL.md montado.
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(CONTEUDO['SKILL.md']!.length);
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });

  it('HEAD numa skill fora do vMCP continua 404', async () => {
    db.getSkillSummary.mockResolvedValue(null);
    const base = await subir();

    expect((await fetch(`${base}/skills/nao-existe/download`, { method: 'HEAD' })).status).toBe(404);
  });
});

describe('GET nas rotas de download segue contando', () => {
  it('o pacote sai inteiro e conta um download', async () => {
    const base = await subir();

    const res = await fetch(`${base}/skills/minha-skill/download`);
    const zip = Buffer.from(await res.arrayBuffer());
    await registroAssentou();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    // Assinatura de ZIP: o pacote veio de verdade.
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(db.listFiles).toHaveBeenCalledTimes(1);
    expect(db.readFile).toHaveBeenCalledTimes(ARQUIVOS.length);
    expect(db.recordSkillAccess).toHaveBeenCalledTimes(1);
    expect(db.recordSkillAccess).toHaveBeenCalledWith(
      expect.objectContaining({ skillUuid: 'uuid-1', kind: 'download', surface: 'download', virtualMcpUuid: 'mcp-1' }),
    );
  });

  it('o SKILL.md avulso conta uma visualização; outro arquivo, não', async () => {
    const base = await subir();

    await (await fetch(`${base}/skills/minha-skill/files/ref/extra.md`)).text();
    await registroAssentou();
    expect(db.recordSkillAccess).not.toHaveBeenCalled();

    const corpo = await (await fetch(`${base}/skills/minha-skill/files/SKILL.md`)).text();
    await registroAssentou();
    expect(corpo).toContain('# Minha Skill');
    expect(db.recordSkillAccess).toHaveBeenCalledTimes(1);
    expect(db.recordSkillAccess).toHaveBeenCalledWith(expect.objectContaining({ kind: 'view', surface: 'file' }));
  });
});
