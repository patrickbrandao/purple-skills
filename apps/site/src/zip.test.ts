import { PassThrough } from 'node:stream';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { extractZip, type SkillFileMeta, type SkillMeta } from '@purple-skills/shared';
import { streamSkillZip, type LerArquivo } from './zip.js';

/**
 * O contrato que a rota de download depende: o pacote sai **em fluxo**, um
 * arquivo lido por vez. O que se testa aqui é justamente o que o
 * `tasks/044-DOWNLOAD-CARREGA-A-SKILL-INTEIRA-EM-MEMORIA.md` cobra — nenhuma
 * leitura adiantada — e os dois caminhos de erro, que dependem de a resposta já
 * ter começado ou não.
 */

const meta: SkillMeta = {
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  tags: ['git'],
};

const lista = (...caminhos: string[]): SkillFileMeta[] =>
  caminhos.map((relativePath) => ({
    relativePath,
    mimeType: 'text/markdown',
    sizeBytes: 10,
    isText: true,
  }));

/** Resposta de mentira: coleta os bytes e registra os cabeçalhos. */
function resposta() {
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  // `destroy(err)` numa resposta de verdade derruba o socket; num `PassThrough`
  // ele emite `error`, que sem ouvinte virava exceção não tratada no teste.
  sink.on('error', () => {});

  const headers: Record<string, string> = {};
  const res = sink as unknown as Response;
  res.setHeader = ((name: string, value: string) => {
    headers[name] = value;
    return res;
  }) as Response['setHeader'];

  return {
    res,
    headers,
    bytes: () => chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    zip: () => Buffer.concat(chunks),
  };
}

/** Leitor que conta as chamadas e devolve o caminho como conteúdo. */
function leitor(conteudo: Record<string, string | null>): { ler: LerArquivo; lidos: string[] } {
  const lidos: string[] = [];
  const ler: LerArquivo = async (relativePath) => {
    lidos.push(relativePath);
    const texto = conteudo[relativePath];
    if (texto === null || texto === undefined) return null;
    return {
      relativePath,
      mimeType: 'text/markdown',
      sizeBytes: Buffer.byteLength(texto),
      isText: true,
      buffer: Buffer.from(texto, 'utf8'),
    };
  };
  return { ler, lidos };
}

/** As entradas do ZIP recebido, com o prefixo da pasta preservado. */
function entradas(zip: Buffer) {
  return extractZip(zip, { stripSingleRootDir: false }).map((file) => ({
    path: file.relativePath,
    text: file.textContent,
  }));
}

describe('streamSkillZip', () => {
  it('lê um arquivo por vez, na ordem da lista, e monta o SKILL.md dos metadados', async () => {
    const saida = resposta();
    const { ler, lidos } = leitor({ 'SKILL.md': '# corpo', 'ref/extra.md': 'extra' });

    await streamSkillZip(saida.res, 'minha-skill', lista('SKILL.md', 'ref/extra.md'), ler, meta);

    expect(lidos).toEqual(['SKILL.md', 'ref/extra.md']);
    expect(saida.headers['Content-Disposition']).toBe('attachment; filename="minha-skill.zip"');
    // Sem `Content-Length`: o tamanho só se conhece depois de comprimir.
    expect(saida.headers['Content-Length']).toBeUndefined();
    expect(entradas(saida.zip())).toEqual([
      {
        path: 'minha-skill/SKILL.md',
        text:
          '---\nname: minha-skill\ndescription: Faz coisas\nmetadata:\n  title: Minha Skill\n' +
          '  tags: git\n---\n\n# corpo',
      },
      { path: 'minha-skill/ref/extra.md', text: 'extra' },
    ]);
  });

  it('não lê o último arquivo antes de escrever os primeiros', async () => {
    const saida = resposta();
    let liberar = () => {};
    const travado = new Promise<void>((resolve) => {
      liberar = resolve;
    });

    const lidos: string[] = [];
    const ler: LerArquivo = async (relativePath) => {
      lidos.push(relativePath);
      if (relativePath === 'z.md') await travado;
      return {
        relativePath,
        mimeType: 'text/markdown',
        sizeBytes: 1,
        isText: true,
        buffer: Buffer.from('x'.repeat(64), 'utf8'),
      };
    };

    const pendente = streamSkillZip(saida.res, 'minha-skill', lista('a.md', 'z.md'), ler, meta);
    await vi.waitFor(() => expect(lidos).toEqual(['a.md', 'z.md']));

    // A entrada anterior já desceu para o cliente enquanto a última nem foi
    // lida: é isso que mantém uma só em memória.
    expect(saida.bytes()).toBeGreaterThan(0);
    liberar();
    await pendente;
    expect(entradas(saida.zip()).map((e) => e.path)).toEqual(['minha-skill/a.md', 'minha-skill/z.md']);
  });

  it('segue sem o arquivo que desapareceu entre a listagem e a leitura', async () => {
    const saida = resposta();
    const { ler } = leitor({ 'SKILL.md': '# corpo', 'sumiu.md': null });

    await streamSkillZip(saida.res, 'minha-skill', lista('SKILL.md', 'sumiu.md'), ler, meta);

    expect(entradas(saida.zip()).map((e) => e.path)).toEqual(['minha-skill/SKILL.md']);
  });

  it('propaga a falha que acontece antes do primeiro byte — a rota ainda responde 500', async () => {
    const saida = resposta();
    const ler: LerArquivo = async () => {
      throw new Error('banco fora');
    };

    await expect(
      streamSkillZip(saida.res, 'minha-skill', lista('SKILL.md'), ler, meta),
    ).rejects.toThrow('banco fora');
    expect(saida.bytes()).toBe(0);
    expect(saida.headers['Content-Type']).toBeUndefined();
  });

  it('derruba a conexão quando a falha chega com a resposta já em curso', async () => {
    const saida = resposta();
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ler } = leitor({ 'SKILL.md': '# corpo' });
    const lerDepois: LerArquivo = async (path) => {
      if (path === 'estoura.md') throw new Error('banco fora no meio');
      return ler(path);
    };

    // Não rejeita: o status já foi enviado, então não há resposta de erro a dar.
    await streamSkillZip(
      saida.res,
      'minha-skill',
      lista('SKILL.md', 'estoura.md'),
      lerDepois,
      meta,
    );

    expect(saida.res.destroyed).toBe(true);
    expect(erro).toHaveBeenCalled();
    erro.mockRestore();
  });
});
