import type { Response } from 'express';
import archiver from 'archiver';
import type { FileContent } from '@purple-skills/db';
import {
  composeSkillMd,
  isSkillMd,
  type SkillFileMeta,
  type SkillMeta,
} from '@purple-skills/shared';

/**
 * Nível de compressão do pacote: o padrão do zlib, não o máximo.
 *
 * Em conteúdo de skill — texto, quase sempre — o 9 não paga: medido sobre os
 * arquivos deste repositório (3,6 MB de md/ts/css/sql), ele tira 0,34% do
 * tamanho e cobra 38% mais CPU que o 6. E o download é a rota anônima mais cara.
 */
const NIVEL_COMPRESSAO = 6;

/** Lê um arquivo da skill. Chamado só quando chega a vez dele no pacote. */
export type LerArquivo = (relativePath: string) => Promise<FileContent | null>;

/** A resposta fechou antes do fim: o cliente desistiu, não é erro do servidor. */
class ClienteDesistiu extends Error {}

/**
 * Envia os arquivos da skill como um ZIP gerado on-the-fly (streaming). O
 * pacote `.skill` é o mesmo ZIP — só muda a extensão do arquivo baixado.
 *
 * Recebe a **lista** dos arquivos e um leitor, não o conteúdo: cada arquivo é
 * lido na vez dele e o `await` da entrada anterior (`entradaEscrita`) mantém uma
 * só em memória. Antes a skill inteira era carregada antes do primeiro byte, e
 * como o `archiver` é streaming mas a fila dele não é, poucos downloads
 * simultâneos de uma skill grande estouravam o `mem_limit` do container. De
 * quebra, a leitura passa a seguir o ritmo do cliente: quem baixa devagar não
 * acumula pacote nenhum no servidor.
 *
 * Nada de `Content-Length`: o tamanho do ZIP só se conhece quando ele acaba. Os
 * cabeçalhos também só são escritos na primeira entrada, e é isso que separa os
 * dois tratamentos de erro — antes do primeiro byte a falha ainda pode virar um
 * 500 de verdade (o `throw` devolve ao `asyncRoute`); depois dele o status já
 * foi, e só resta derrubar a conexão para o cliente não guardar um `.zip`
 * truncado com cara de íntegro.
 */
export async function streamSkillZip(
  res: Response,
  slug: string,
  files: readonly SkillFileMeta[],
  ler: LerArquivo,
  meta: SkillMeta,
  ext: 'zip' | 'skill' = 'zip',
): Promise<void> {
  const archive = archiver('zip', { zlib: { level: NIVEL_COMPRESSAO } });

  // Ouvinte permanente: `error` sem ouvinte num stream do Node derruba o
  // processo, e entre duas entradas — enquanto o banco responde — não há
  // nenhum `await` sobre o `archive` para capturá-lo.
  let falha: Error | null = null;
  archive.on('error', (err: Error) => {
    falha ??= err;
  });

  let comecou = false;
  const comecar = (): void => {
    if (comecou) return;
    comecou = true;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.${ext}"`);
    res.setHeader('Cache-Control', 'no-store');
    archive.pipe(res);
  };

  try {
    for (const file of files) {
      const conteudo = await ler(file.relativePath);
      if (falha) throw falha;
      // Arquivo apagado entre a listagem e a leitura: o pacote sai sem ele, em
      // vez de a resposta morrer no meio por causa de uma edição concorrente.
      if (!conteudo) continue;

      // O SKILL.md do pacote nasce dos metadados da skill: o que está gravado é
      // só o corpo do prompt.
      const content = isSkillMd(conteudo.relativePath)
        ? Buffer.from(composeSkillMd(meta, conteudo.buffer.toString('utf8')), 'utf8')
        : conteudo.buffer;

      comecar();
      archive.append(content, { name: `${slug}/${conteudo.relativePath}` });
      await entradaEscrita(archive, res);
    }

    // Skill sem arquivo nenhum continua devolvendo um ZIP vazio, como antes.
    comecar();
    await archive.finalize();
    if (falha) throw falha;
  } catch (err) {
    archive.abort();
    if (err instanceof ClienteDesistiu) return;
    if (!comecou) throw err;
    console.error('[zip] erro ao gerar pacote:', (err as Error).message);
    res.destroy(err as Error);
  }
}

/**
 * Espera o `archiver` consumir a entrada que acabou de ser acrescentada.
 *
 * É o que dá contrapressão: sem isso os `append` entram todos na fila interna
 * do archiver e o processo volta a segurar a skill inteira. A resposta também é
 * vigiada — se o cliente desiste, o `entry` não chega nunca e a leitura ficaria
 * pendurada, segurando a requisição e o que ela já leu.
 */
function entradaEscrita(archive: archiver.Archiver, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.destroyed) {
      reject(new ClienteDesistiu('resposta já fechada'));
      return;
    }

    function limpar(): void {
      archive.off('entry', naEntrada);
      archive.off('error', noErro);
      res.off('close', noFechamento);
    }
    function naEntrada(): void {
      limpar();
      resolve();
    }
    function noErro(err: Error): void {
      limpar();
      reject(err);
    }
    function noFechamento(): void {
      limpar();
      reject(new ClienteDesistiu('resposta fechada pelo cliente'));
    }

    archive.once('entry', naEntrada);
    archive.once('error', noErro);
    res.once('close', noFechamento);
  });
}
