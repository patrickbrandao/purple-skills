/**
 * A divisão de uma skill em textos canônicos (`docs/14-rag.md` §5.3).
 *
 * Uma skill vira:
 *
 *   * **um texto de metadados** com nome, descrição e tags — a linha de tags
 *     sai quando não há tag, e as tags vão em ordem alfabética para o texto
 *     não mudar quando a ordem de inserção muda;
 *   * **um texto por arquivo** de texto que caiba no teto, ou **uma parte por
 *     pedaço** quando não couber.
 *
 * Tudo é determinístico: a mesma skill sempre dá os mesmos textos, na mesma
 * ordem, com os mesmos hashes. É o que faz uma reindexação sem mudança de
 * conteúdo não gastar embedding nenhum.
 *
 * **Nenhum prefixo de contexto.** Pôr o nome da skill antes de cada pedaço
 * deixaria o texto diferente a cada skill, e duas skills com o mesmo arquivo
 * deixariam de compartilhar o vetor. O nome já está no texto de metadados.
 */
import type { EmbeddingModel } from './driver.js';

/** Onde um texto canônico aparece. Espelha `rag_skill_texts` da `020`. */
export type SkillTextOccurrence = {
  source: 'meta' | 'file';
  /** Vazio em `meta`; o caminho do arquivo em `file`. */
  relativePath: string;
  /** Começa em 0, na ordem do arquivo. */
  part: number;
  /** Nulo em `meta`; o id do arquivo em `file`. */
  fileId: string | null;
  /** O texto canônico, sem prefixo. */
  content: string;
};

/** A skill como o indexador a lê para dividir. */
export type SkillForChunking = {
  name: string;
  description: string | null;
  tags: readonly string[];
  files: readonly {
    id: string;
    relativePath: string;
    textContent: string | null;
  }[];
};

export type ChunkOptions = {
  /** Teto de caracteres por parte. Padrão: o do modelo. */
  maxPartChars?: number;
  /** Arquivo maior que isto é pulado inteiro. Padrão: 256 KB. */
  maxFileBytes?: number;
};

/** Um arquivo que não foi dividido, e por quê. */
export type SkippedFile = {
  relativePath: string;
  reason: 'grande-demais' | 'vazio';
  /** Tamanho em bytes UTF-8, quando o motivo é tamanho. */
  bytes?: number;
};

export type ChunkResult = {
  occurrences: SkillTextOccurrence[];
  skipped: SkippedFile[];
};

/** Teto de bytes por arquivo. Acima disso o arquivo é pulado, com o motivo no log. */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

/**
 * O texto de metadados: nome, descrição e tags, uma por linha.
 *
 * A descrição ausente ou vazia simplesmente não gera linha — a alternativa
 * seria uma linha em branco no meio do texto, que muda o vetor sem dizer nada.
 */
export function metaText(skill: {
  name: string;
  description: string | null;
  tags: readonly string[];
}): string {
  const linhas: string[] = [skill.name.trim()];

  const descricao = skill.description?.trim();
  if (descricao) linhas.push(descricao);

  const tags = [...skill.tags].map((t) => t.trim()).filter(Boolean).sort();
  if (tags.length > 0) linhas.push(tags.join(', '));

  return linhas.join('\n');
}

/**
 * Divide um texto em partes de até `maxChars`.
 *
 * A ordem de preferência para o corte é a da §5.3: primeiro nos títulos
 * Markdown, depois nas linhas em branco, por último no teto. Cortar num título
 * mantém a seção inteira num pedaço só, que é o que dá sentido ao vetor; o
 * corte cego no teto é o último recurso, para um arquivo sem estrutura nenhuma.
 *
 * Sem sobreposição: ela multiplicaria o custo de embedding para ganhar pouco
 * num acervo de documentação curta.
 */
export function splitText(text: string, maxChars: number): string[] {
  const inteiro = text.trim();
  if (inteiro === '') return [];
  if (inteiro.length <= maxChars) return [inteiro];

  // Blocos que preferimos não quebrar, do mais forte para o mais fraco.
  const porTitulo = quebrar(inteiro, /\n(?=#{1,6} )/g);
  const partes: string[] = [];

  for (const bloco of porTitulo) {
    if (bloco.length <= maxChars) {
      empurrar(partes, bloco, maxChars);
      continue;
    }
    for (const paragrafo of quebrar(bloco, /\n(?=\s*\n)/g)) {
      if (paragrafo.length <= maxChars) {
        empurrar(partes, paragrafo, maxChars);
        continue;
      }
      for (const pedaco of fatiarNoTeto(paragrafo, maxChars)) empurrar(partes, pedaco, maxChars);
    }
  }

  return partes.map((p) => p.trim()).filter((p) => p !== '');
}

/** Junta ao último pedaço enquanto couber, para não gerar partes minúsculas. */
function empurrar(partes: string[], bloco: string, maxChars: number): void {
  const ultimo = partes[partes.length - 1];
  if (ultimo !== undefined && ultimo.length + 1 + bloco.length <= maxChars) {
    partes[partes.length - 1] = `${ultimo}\n${bloco}`;
    return;
  }
  partes.push(bloco);
}

function quebrar(text: string, separador: RegExp): string[] {
  return text.split(separador).filter((p) => p.trim() !== '');
}

/** Último recurso: corta no teto, preferindo a última quebra de linha do pedaço. */
function fatiarNoTeto(text: string, maxChars: number): string[] {
  const partes: string[] = [];
  let resto = text;

  while (resto.length > maxChars) {
    const janela = resto.slice(0, maxChars);
    const quebra = janela.lastIndexOf('\n');
    // Só respeita a quebra se ela não deixar um pedaço ridiculamente pequeno.
    const corte = quebra > maxChars / 2 ? quebra : maxChars;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte);
  }

  if (resto.trim() !== '') partes.push(resto);
  return partes;
}

/**
 * Divide a skill inteira nos textos canônicos que o indexador vai gravar.
 *
 * Os arquivos saem em ordem de caminho, para a lista não depender da ordem em
 * que o banco devolveu as linhas.
 */
export function chunkSkill(
  skill: SkillForChunking,
  model: EmbeddingModel,
  options: ChunkOptions = {},
): ChunkResult {
  const maxPartChars = options.maxPartChars ?? model.maxPartChars;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const occurrences: SkillTextOccurrence[] = [];
  const skipped: SkippedFile[] = [];

  const meta = metaText(skill);
  if (meta.trim() !== '') {
    occurrences.push({ source: 'meta', relativePath: '', part: 0, fileId: null, content: meta });
  }

  const arquivos = [...skill.files]
    .filter((f) => f.textContent !== null)
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  for (const arquivo of arquivos) {
    const conteudo = arquivo.textContent ?? '';

    if (conteudo.trim() === '') {
      skipped.push({ relativePath: arquivo.relativePath, reason: 'vazio' });
      continue;
    }

    const bytes = Buffer.byteLength(conteudo, 'utf8');
    if (bytes > maxFileBytes) {
      skipped.push({ relativePath: arquivo.relativePath, reason: 'grande-demais', bytes });
      continue;
    }

    const partes = splitText(conteudo, maxPartChars);
    partes.forEach((content, part) => {
      occurrences.push({
        source: 'file',
        relativePath: arquivo.relativePath,
        part,
        fileId: arquivo.id,
        content,
      });
    });
  }

  return { occurrences, skipped };
}
