import { Writable } from 'node:stream';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import { readIntEnv } from './env.js';
import { isSkillMd, isTextualContent, mimeTypeFor, normalizeRelativePath } from './paths.js';

export type ZipEntryInput = {
  relativePath: string;
  content: Buffer | string;
};

/**
 * Gera um ZIP com as entradas informadas e escreve no stream de saída.
 * Resolve quando o ZIP terminou de ser escrito.
 */
export function writeZip(entries: readonly ZipEntryInput[], out: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    out.on('close', () => resolve());
    out.on('error', reject);

    archive.pipe(out);
    for (const entry of entries) {
      const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
      archive.append(data, { name: entry.relativePath });
    }
    archive.finalize().catch(reject);
  });
}

/** Gera o ZIP inteiramente em memória — usado em testes e no MCP admin. */
export async function zipToBuffer(entries: readonly ZipEntryInput[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });

  await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    sink.on('finish', () => resolve());
    archive.pipe(sink);
    for (const entry of entries) {
      const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
      archive.append(data, { name: entry.relativePath });
    }
    archive.finalize().catch(reject);
  });

  return Buffer.concat(chunks);
}

export type ExtractedFile = {
  relativePath: string;
  mimeType: string;
  textContent: string | null;
  binaryContent: Buffer | null;
  sizeBytes: number;
};

/**
 * Teto padrão do conteúdo descomprimido de um ZIP.
 *
 * Lido com `readIntEnv`: um valor inválido aqui viraria `NaN` e desligaria a
 * checagem de zip bomb sem avisar ninguém.
 */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = readIntEnv(
  'ZIP_MAX_UNCOMPRESSED_BYTES',
  256 * 1024 * 1024,
  { min: 1024 },
);

/** Teto padrão de entradas por ZIP. */
export const DEFAULT_MAX_ZIP_ENTRIES = readIntEnv('ZIP_MAX_ENTRIES', 512);

/**
 * Expansão máxima do DEFLATE: 1032 bytes de saída por byte de entrada. É o teto
 * do formato, não uma heurística de razão de compressão — serve como cota
 * superior confiável para o que uma entrada consegue inflar quando o cabeçalho
 * não declara um tamanho utilizável.
 */
const MAX_EXPANSAO_DEFLATE = 1032;

export type ReadZipEntriesOptions = {
  /** Teto do total descomprimido. Acima disso, a leitura lança. */
  maxUncompressedBytes?: number;
  /** Teto do número de entradas do ZIP. */
  maxEntries?: number;
};

export type ExtractZipOptions = {
  /**
   * Quando o ZIP tem uma única pasta raiz **que contém o `SKILL.md`** — o padrão
   * de `zip -r skill.zip skill/` e o formato do pacote que o painel, o site e o
   * MCP público entregam (`<slug>/SKILL.md`) —, essa pasta é removida dos
   * caminhos. Ligado por padrão.
   *
   * O `SKILL.md` é o que separa embrulho de subpasta: sem essa condição, um
   * envio parcial (`zip -r scripts.zip scripts/`) a uma skill que já existe
   * perdia a pasta e era gravado na raiz, ao lado dos originais (`tasks/075`).
   */
  stripSingleRootDir?: boolean;
  /** Teto do total descomprimido. Acima disso, `extractZip` lança. */
  maxUncompressedBytes?: number;
  /** Teto do número de entradas do ZIP. */
  maxEntries?: number;
  /**
   * Deixa passar um `SKILL.md` que não é texto UTF-8, como binário e byte a
   * byte, em vez de recusar o pacote inteiro (`ZipContentError`).
   *
   * Desligado por padrão, e continua assim em tudo que cria skill: lá quem lê
   * o arquivo faz `textContent ?? ''`, e um SKILL.md binário viraria prompt
   * vazio gravado por cima. Quem liga é a **quarentena**
   * (`docs/15-quarentena.md`), onde o arquivo é bytes crus que ninguém
   * decodifica — e onde recusar o pacote seria recusar justamente o que o
   * espaço existe para consertar: o SKILL.md em Windows-1252 ou UTF-16 que sai
   * de um editor Windows. Quem cobra a codificação lá é a **aprovação**.
   */
  allowBinarySkillMd?: boolean;
};

/** Base dos erros de ZIP causados pelo arquivo enviado — sempre 400, nunca 500. */
export class ZipError extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

/** ZIP recusado por exceder um limite (tamanho descomprimido ou nº de entradas). */
export class ZipLimitError extends ZipError {
  constructor(message: string) {
    super(message, 'ZipLimitError');
  }
}

/** ZIP ilegível: não é um ZIP, está truncado ou corrompido. */
export class ZipFormatError extends ZipError {
  constructor(message: string) {
    super(message, 'ZipFormatError');
  }
}

/** ZIP legível, com conteúdo que não dá para gravar: o `SKILL.md` que não é texto. */
export class ZipContentError extends ZipError {
  constructor(message: string) {
    super(message, 'ZipContentError');
  }
}

/**
 * Lê as entradas de um ZIP em memória: caminho normalizado e bytes crus, na
 * ordem do arquivo. Ignora diretórios, arquivos de metadados de SO e caminhos
 * inseguros; não desembrulha pasta raiz e não decide texto × binário.
 *
 * O conteúdo descomprimido é limitado: um ZIP de poucos KB pode expandir para
 * gigabytes ("zip bomb") e derrubar o processo por falta de memória. O tamanho
 * declarado no cabeçalho é checado antes de descomprimir (evita materializar a
 * entrada), e o tamanho real é somado depois, porque um ZIP malformado pode
 * declarar qualquer coisa. Quando o cabeçalho declara zero — o valor que
 * desligava o teto do zlib dentro do `adm-zip` —, a entrada só é aberta se os
 * bytes comprimidos não puderem inflar além do que resta do limite.
 *
 * O número de entradas segue a mesma régua e é conferido **antes** de
 * `getEntries()`: só percorrer o diretório central já custa memória proporcional
 * ao que ele declara (ver o comentário no corpo).
 *
 * É o miolo de `extractZip` e o caminho zip do `extractArchive` (`archive.ts`):
 * as proteções acima valem igual para o .zip de uma skill e para o bundle.
 */
export function readZipEntries(
  buffer: Buffer,
  options: ReadZipEntriesOptions = {},
): { path: string; data: Buffer }[] {
  const {
    maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
    maxEntries = DEFAULT_MAX_ZIP_ENTRIES,
  } = options;
  const entradasDemais = (quantas: number) =>
    new ZipLimitError(`O .zip tem entradas demais (${quantas}); o limite é ${maxEntries}.`);

  // `adm-zip` lança um Error genérico ("Invalid or unsupported zip format")
  // para qualquer coisa que não seja um ZIP; sem este `catch` isso viraria 500.
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new ZipFormatError(`O arquivo não é um .zip válido: ${(err as Error).message}`);
  }

  // O teto vale sobre o número **declarado** no fim do diretório central, antes
  // de materializar seja o que for. Conferir depois de `getEntries()` — a ordem
  // que estava aqui — não protege nada: o `getEntries()` do `adm-zip` 0.6.0
  // dimensiona a lista por esse mesmo número declarado e cria um `ZipEntry` por
  // registro, medidos 9 a 10 KB de RSS cada. E o número não para nos 65.535 de
  // 16 bits, porque o `adm-zip` lê o EOCD ZIP64: um .zip de 9 MB declarando
  // 200.000 entradas (registros de 47 bytes, todos podendo apontar para o mesmo
  // cabeçalho local) consumia 1,8 GB e 1,6 s antes de a comparação acontecer. O
  // teto de bytes descomprimidos não socorre: nada foi descomprimido ainda.
  // `getEntryCount()` devolve o `diskEntries` do cabeçalho sem carregar entrada
  // nenhuma — o construtor só lê o fim do diretório central, já que a opção
  // `readEntries` do `adm-zip` vem desligada.
  const declaradas = zip.getEntryCount();
  if (declaradas > maxEntries) throw entradasDemais(declaradas);

  let entries: ReturnType<AdmZip['getEntries']>;
  try {
    entries = zip.getEntries();
  } catch (err) {
    throw new ZipFormatError(`O arquivo não é um .zip válido: ${(err as Error).message}`);
  }

  // O declarado é número do arquivo enviado, como os tamanhos de cada entrada
  // mais abaixo: serve para recusar, nunca como medida do que existe. Por isso a
  // contagem do que voltou materializado continua valendo, mesmo hoje, em que o
  // `adm-zip` entrega exatamente o que foi declarado.
  if (entries.length > maxEntries) throw entradasDemais(entries.length);

  const limitMb = Math.round(maxUncompressedBytes / (1024 * 1024));
  const tooBig = () =>
    new ZipLimitError(`O conteúdo descomprimido do .zip passa do limite de ${limitMb} MB.`);

  let total = 0;
  const raw: { path: string; data: Buffer }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // Os dois tamanhos vêm do diretório central do arquivo enviado: servem para
    // recusar a entrada, nunca como medida do que foi extraído.
    const declarado = entry.header?.size ?? 0;
    const comprimido = entry.header?.compressedSize ?? 0;

    // Checagem barata antes de descomprimir a entrada.
    if (total + declarado > maxUncompressedBytes) throw tooBig();

    const path = normalizeRelativePath(entry.entryName);
    if (!path) continue;
    if (isJunkPath(path)) continue;

    // Tamanho declarado zerado é o caso em que o teto acima não protege nada:
    // `adm-zip` só repassa `maxOutputLength` ao zlib quando o declarado é maior
    // que zero, então com zero a descompressão fica sem limite e o total só
    // seria conferido com a entrada inteira já em memória (um .zip de 250 KB
    // declarando zero alocava centenas de MB apesar do limite de 1 KB).
    // Sem o declarado, o único número que a descompressão não pode desmentir é
    // o de bytes comprimidos — `adm-zip` entrega ao zlib no máximo essa fatia do
    // buffer —, e o pior caso do DEFLATE limita a saída a 1032× a entrada.
    // Arquivo vazio de verdade tem os dois tamanhos em zero e segue passando;
    // o `zipfile` do Python grava o vazio como DEFLATE de 2 bytes, que também
    // cabe nessa cota.
    if (declarado <= 0 && comprimido * MAX_EXPANSAO_DEFLATE > maxUncompressedBytes - total) {
      throw tooBig();
    }

    let data: Buffer;
    try {
      data = entry.getData();
    } catch (err) {
      throw new ZipFormatError(
        `Não foi possível ler "${entry.entryName}" do .zip: ${(err as Error).message}`,
      );
    }
    total += data.byteLength;
    if (total > maxUncompressedBytes) throw tooBig();

    // Depois de descomprimir porque o AppleDouble se prova pelo conteúdo, não
    // pelo nome (ver `isAppleDoubleFile`). O `.zip` do macOS quase sempre traz
    // esse metadado dentro de `__MACOSX/`, já descartado acima; solto, ao lado
    // do arquivo de verdade, é o que o `tar` faz — e o filtro é o mesmo.
    if (isAppleDoubleFile(path, data)) continue;

    raw.push({ path, data });
  }

  return raw;
}

/**
 * Extrai um ZIP em memória para a representação usada na tabela `files`.
 * Ignora diretórios, arquivos de metadados de SO e caminhos inseguros, e aplica
 * os tetos de zip bomb de `readZipEntries`, que é quem lê as entradas.
 *
 * Todo erro causado pelo arquivo enviado é um `ZipError`: limite estourado,
 * ZIP ilegível e o `SKILL.md` que não é texto (`ZipContentError`).
 */
export function extractZip(buffer: Buffer, options: ExtractZipOptions = {}): ExtractedFile[] {
  const {
    stripSingleRootDir = true,
    maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
    maxEntries = DEFAULT_MAX_ZIP_ENTRIES,
    allowBinarySkillMd = false,
  } = options;

  const raw = readZipEntries(buffer, { maxUncompressedBytes, maxEntries });

  const prefix = stripSingleRootDir ? commonRootDir(raw.map((e) => e.path)) : null;

  const files: ExtractedFile[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const path = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);

    const file = toExtractedFile(path, entry.data);
    // Um anexo que não é texto segue como binário, intacto. O arquivo principal
    // não tem essa saída: quem chama lê `textContent ?? ''`, e um SKILL.md
    // binário viraria corpo vazio gravado por cima do prompt da skill — a não
    // ser com `allowBinarySkillMd`, que só a quarentena liga (ver a opção).
    if (isSkillMd(path) && file.textContent === null && !allowBinarySkillMd) {
      throw new ZipContentError(
        'O SKILL.md do .zip não é um texto UTF-8 válido (tem byte nulo ou está em outra ' +
          'codificação, como Windows-1252). Converta-o para UTF-8 e envie de novo.',
      );
    }
    files.push(file);
  }

  return files;
}

/**
 * Monta a linha de `files` a partir de um caminho + bytes crus.
 *
 * Texto × binário sai de `isTextualContent` (`paths.ts`): o que não é UTF-8
 * válido vai como binário, com os bytes que chegaram. `fileColumns`, no banco,
 * tem a sua cópia da régua — as duas precisam dizer o mesmo.
 */
export function toExtractedFile(relativePath: string, data: Buffer): ExtractedFile {
  const mimeType = mimeTypeFor(relativePath);
  const textual = isTextualContent(mimeType, data);

  return {
    relativePath,
    mimeType,
    textContent: textual ? data.toString('utf8') : null,
    binaryContent: textual ? null : data,
    sizeBytes: data.byteLength,
  };
}

/**
 * Lixo de sistema operacional, em qualquer segmento do caminho. Exportado
 * porque o `.tar` e o envelope de arquivo único (`archive.ts`) precisam da
 * mesma régua: duas cópias dela começariam iguais e acabariam diferentes.
 */
export function isJunkPath(path: string): boolean {
  const segments = path.split('/');
  return segments.some(
    (segment) => segment === '__MACOSX' || segment === '.DS_Store' || segment === 'Thumbs.db',
  );
}

/** Magic de um arquivo AppleDouble: 00 05 16 07 nos quatro primeiros bytes. */
const ASSINATURA_APPLEDOUBLE = Buffer.from([0x00, 0x05, 0x16, 0x07]);

/**
 * O irmão `._<nome>` que o `tar` do macOS grava para cada arquivo e diretório
 * que tenha atributo estendido — e no macOS quase tudo tem
 * (`com.apple.provenance`).
 *
 * Medido na verificação da importação de bundle: o `.tar.gz` de uma coleção de
 * skills feita num Mac voltou com `._SKILL.md`, `._diagrama.png` e
 * `ref/._tecnicas.md` ao lado dos arquivos de verdade — **27 dos 41 membros**
 * daquele pacote, metade deles binário ilegível, consumindo o teto de 512. E
 * não adianta conferir com `tar -tf`: o `tar` do macOS **esconde** esses
 * membros ao listar, porque os reagrega em atributo estendido. Quem os mostra é
 * um leitor que não faz isso (o `tarfile` do Python, ou este módulo). No `.zip` o
 * problema não aparece porque o `zip` junta esse metadado em `__MACOSX/`, que
 * `isJunkPath` já descarta; no tar eles vêm soltos, e por dois caminhos: o
 * `bsdtar` que grava o irmão quando não tem onde guardar atributo estendido, e
 * a pasta que passou por um volume não-HFS (pendrive, SMB), onde os `._<nome>`
 * viram arquivos de verdade no disco e qualquer empacotador os leva junto.
 *
 * O nome sozinho não decide: `._config` é nome legítimo, e descartar por
 * prefixo apagaria o arquivo do usuário. Quem decide é a assinatura — os bytes
 * já estão em mão em todo ponto onde isto é chamado, e não há falso positivo.
 */
export function isAppleDoubleFile(path: string, data: Buffer): boolean {
  const nome = path.split('/').pop() ?? '';
  if (!nome.startsWith('._')) return false;
  return data.subarray(0, ASSINATURA_APPLEDOUBLE.length).equals(ASSINATURA_APPLEDOUBLE);
}

/**
 * Retorna a pasta raiz comum a todos os caminhos quando ela é um **embrulho** —
 * o `SKILL.md` está logo dentro dela, em qualquer caixa —, ou `null`.
 *
 * É assim que sai todo pacote exportado (`<slug>/SKILL.md`, ver
 * `apps/site/src/zip.ts`), e toda skill tem um `SKILL.md`: baixar e reenviar
 * continua desembrulhando. Uma raiz única sem ele é subpasta de verdade
 * (`scripts/run.py`, `scripts/util.py`) e fica nos caminhos.
 */
function commonRootDir(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0].split('/');
  if (first.length < 2) return null;
  const root = first[0];
  if (!paths.every((p) => p.startsWith(`${root}/`))) return null;
  return paths.some((p) => isSkillMd(p.slice(root.length + 1))) ? root : null;
}
