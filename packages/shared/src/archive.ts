import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { extract as tarExtract } from 'tar-stream';
import { readIntEnv } from './env.js';
import { normalizeRelativePath } from './paths.js';
import {
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  ZipError,
  ZipFormatError,
  ZipLimitError,
  isAppleDoubleFile,
  isJunkPath,
  readZipEntries,
} from './zip.js';

export type ArchiveFormat =
  | 'zip'
  | 'tar'
  | 'gzip'
  | 'zstd'
  | 'rar'
  | '7z'
  | 'xz'
  | 'bzip2'
  | 'unknown';

/** Uma entrada crua do pacote, antes de virar texto ou binário. */
export type ArchiveEntry = { path: string; data: Buffer };

export type ExtractArchiveOptions = {
  /** Teto do total descomprimido. Padrão: `DEFAULT_MAX_UNCOMPRESSED_BYTES`. */
  maxUncompressedBytes?: number;
  /** Teto de entradas do pacote inteiro. Padrão: `DEFAULT_MAX_BUNDLE_ENTRIES`. */
  maxEntries?: number;
};

/**
 * Teto padrão de entradas de um **bundle**, bem acima do teto de uma skill
 * avulsa (`DEFAULT_MAX_ZIP_ENTRIES`, 512): o `.zip` que o GitHub gera de um
 * repositório de skills passa das 512 entradas só com `.github/` e `docs/`.
 *
 * Lido com `readIntEnv` pela razão do cabeçalho de `env.ts`: um valor escrito
 * errado viraria `NaN`, e toda comparação com `NaN` é falsa — o teto sairia do
 * ar em silêncio.
 */
export const DEFAULT_MAX_BUNDLE_ENTRIES = readIntEnv('BUNDLE_MAX_ENTRIES', 20_000);

/**
 * Formato reconhecido e recusado de propósito (RAR, 7z, xz, bzip2).
 *
 * É `ZipError`, como todo erro causado pelo arquivo enviado, para a borda HTTP
 * responder 400 — ver o mapeamento em `apps/admin/src/api.ts`.
 */
export class ArchiveUnsupportedError extends ZipError {
  constructor(message: string) {
    super(message, 'ArchiveUnsupportedError');
  }
}

/*
 * Assinaturas montadas byte a byte. O `AGENTS.md` proíbe byte de controle
 * literal no fonte — e quase toda assinatura tem um: escrever `'PK\x03\x04'`
 * funciona até a ferramenta de edição "resolver" o escape de volta para o byte
 * cru ao gravar, e aí o `grep` recusa o arquivo. Os comentários trazem a parte
 * legível de cada uma.
 */
const ASSINATURAS_ZIP = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // 'PK' + arquivo comum
  Buffer.from([0x50, 0x4b, 0x05, 0x06]), // 'PK' + zip vazio (só o fim do diretório central)
  Buffer.from([0x50, 0x4b, 0x07, 0x08]), // 'PK' + volume de zip dividido
];
const ASSINATURA_GZIP = Buffer.from([0x1f, 0x8b]);
const ASSINATURA_ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const ASSINATURA_RAR4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]); // 'Rar!'
const ASSINATURA_RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]); // 'Rar!'
const ASSINATURA_7Z = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]); // '7z'
const ASSINATURA_XZ = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]); // '7zXZ'
const ASSINATURA_BZIP2 = Buffer.from([0x42, 0x5a, 0x68]); // 'BZh'
/**
 * O que vem depois do `BZh` + dígito de nível: o magic do primeiro bloco
 * comprimido (os dígitos de π em BCD, `1AY&SY` em ASCII) ou, no arquivo que
 * não comprimiu nada, o magic de fim de fluxo.
 */
const MAGICOS_BZIP2 = [
  Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59]),
  Buffer.from([0x17, 0x72, 0x45, 0x38, 0x50, 0x90]),
];
const ASSINATURA_USTAR = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72]); // 'ustar'

/** O `magic` do cabeçalho tar mora no meio do primeiro bloco, não no começo. */
const OFFSET_USTAR = 257;
const BLOCO_TAR = 512;

/** `buffer` tem exatamente estes bytes a partir de `offset`. */
function casa(buffer: Buffer, offset: number, assinatura: Buffer): boolean {
  // `subarray` além do fim devolve menos bytes, e aí `equals` já é falso: não
  // há comparação fora dos limites para checar à parte.
  return buffer.subarray(offset, offset + assinatura.length).equals(assinatura);
}

/**
 * Um bzip2 de verdade: `BZh`, o dígito de nível (1 a 9) e o magic do bloco.
 *
 * Os três bytes de `BZh` sozinhos não bastam. Medido: um `.tar` íntegro cujo
 * primeiro membro se chama `BZh-notas.md` era recusado como bzip2 — o nome do
 * arquivo é o começo do cabeçalho tar, e caía na assinatura curta.
 */
function ehBzip2(buffer: Buffer): boolean {
  if (!casa(buffer, 0, ASSINATURA_BZIP2)) return false;
  const nivel = buffer[3];
  if (nivel === undefined || nivel < 0x31 || nivel > 0x39) return false;
  return MAGICOS_BZIP2.some((magico) => casa(buffer, 4, magico));
}

/**
 * Detecta o formato pela assinatura. A extensão é dica, a assinatura decide: um
 * `.skill` é um ZIP com outro nome, e o `.rar` que alguém renomeou para `.zip`
 * precisa ser reconhecido como RAR para receber a recusa certa, em vez do
 * "arquivo corrompido" que o leitor de ZIP responderia.
 */
export function detectArchiveFormat(buffer: Buffer): ArchiveFormat {
  if (ASSINATURAS_ZIP.some((assinatura) => casa(buffer, 0, assinatura))) return 'zip';
  if (casa(buffer, 0, ASSINATURA_GZIP)) return 'gzip';
  if (casa(buffer, 0, ASSINATURA_ZSTD)) return 'zstd';
  if (casa(buffer, 0, ASSINATURA_RAR4) || casa(buffer, 0, ASSINATURA_RAR5)) return 'rar';
  if (casa(buffer, 0, ASSINATURA_7Z)) return '7z';
  if (casa(buffer, 0, ASSINATURA_XZ)) return 'xz';

  // O tar não tem assinatura no começo: o que existe é o campo `magic` do
  // cabeçalho, com `ustar` no offset 257 — vale para o POSIX e para o GNU, que
  // grava a mesma palavra ali. Buffer menor que um bloco nunca é tar: sem essa
  // guarda, qualquer coisa que por acaso trouxesse `ustar` naquele ponto
  // passaria a ser lida como pacote.
  if (buffer.length >= BLOCO_TAR && casa(buffer, OFFSET_USTAR, ASSINATURA_USTAR)) return 'tar';

  // O bzip2 fica **depois** do tar de propósito. Das assinaturas que este
  // servidor conhece, a dele é a única feita só de caracteres imprimíveis
  // (`BZh1AY&SY`), e o começo do tar é o nome do primeiro arquivo — ou seja, é
  // a única que um nome de arquivo consegue imitar. O `ustar` no offset 257 é
  // estrutura, não conteúdo: quem passa por ele é tar, e ponto.
  if (ehBzip2(buffer)) return 'bzip2';

  return 'unknown';
}

const FORMATOS_ACEITOS = '.zip, .skill, .tar, .tar.gz, .tgz, .gz, .tar.zst, .tzst, .zst e .zstd';

const NOME_DO_FORMATO: Record<'rar' | '7z' | 'xz' | 'bzip2', string> = {
  rar: 'RAR',
  '7z': '7z',
  xz: 'xz',
  bzip2: 'bzip2',
};

/**
 * Quantos envelopes de compressão encadeados um pacote pode ter.
 *
 * Dois cobrem tudo que é legítimo — `.tar.gz` é um, e o segundo sobra para o
 * `.gz` que alguém recomprimiu ao baixar. Daí em diante é bomba: cada camada
 * multiplica o que sai da anterior, e quem paga é a memória do processo.
 */
const MAX_DESEMBRULHOS = 2;

/**
 * Extrai qualquer pacote aceito para uma lista de entradas cruas.
 *
 * O que sai daqui é o pacote como ele veio: caminhos inteiros, sem cortar pasta
 * raiz — quem decide onde cada skill começa é o `splitBundle` (`bundle.ts`),
 * que precisa do prefixo para separar uma skill da outra.
 *
 * `filename` só é usado no pacote de arquivo único (`SKILL.md.gz`), onde o
 * envelope não guarda nome nenhum.
 */
export async function extractArchive(
  buffer: Buffer,
  filename: string,
  options: ExtractArchiveOptions = {},
): Promise<ArchiveEntry[]> {
  const {
    maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
    maxEntries = DEFAULT_MAX_BUNDLE_ENTRIES,
  } = options;
  // Quanto o pacote já materializou nas camadas abertas até aqui. O teto é
  // **um só para o pacote inteiro**: cada envelope desconta o que produziu, e o
  // leitor de dentro fica com o que sobrou.
  //
  // Enquanto o teto valia de novo a cada camada, o mesmo conteúdo de 250 MB
  // custava (maxRSS, Node 26) 346 MB em `.zip`, 653 MB em `.tar.gz` e 871 MB em
  // gzip(gzip(tar)) — contra os "~2x o teto descomprimido + 200 MB" com que o
  // `docker-compose.yml` dimensiona o container. Com `mem_limit` de 1536m e sem
  // swap, três envios de 264 KB em paralelo bastavam para o OOM killer.
  let gasto = 0;

  let atual = buffer;
  let nome = filename;

  for (let desembrulhos = 0; ; desembrulhos += 1) {
    const formato = detectArchiveFormat(atual);

    switch (formato) {
      // Decisão do mantenedor: abrir RAR exigiria o `node-unrar-js`, cuja
      // cláusula do UnRAR (proíbe reconstruir o compressor) não combina com a
      // licença MIT do projeto. 7z, xz e bzip2 entram na mesma recusa por
      // coerência — e porque a mensagem que diz o que fazer vale mais que um
      // "arquivo corrompido" vindo do leitor de ZIP.
      case 'rar':
      case '7z':
      case 'xz':
      case 'bzip2':
        throw new ArchiveUnsupportedError(
          `O arquivo enviado está em ${NOME_DO_FORMATO[formato]}, um formato que este ` +
            `servidor não abre. Reempacote em um destes: ${FORMATOS_ACEITOS}.`,
        );

      // Os dois leitores recebem o teto cheio **mais** o `gasto` e descontam um
      // do outro lá dentro, para a mensagem de recusa citar o limite que o
      // operador configurou, e não o resto da conta. O de tar é daqui; o de zip
      // mora no `zip.ts`, que só aceita um número e o usa também na mensagem —
      // ver `lerZipEntries`.
      case 'zip':
        return primeiroVence(lerZipEntries(atual, { maxUncompressedBytes, maxEntries, gasto }));

      case 'tar':
        return primeiroVence(
          await readTarEntries(atual, { maxUncompressedBytes, maxEntries, gasto }),
        );

      case 'gzip':
      case 'zstd': {
        if (desembrulhos >= MAX_DESEMBRULHOS) {
          throw new ZipLimitError(
            `O pacote tem mais de ${MAX_DESEMBRULHOS} camadas de compressão encadeadas. ` +
              'Um .gz dentro de .gz dentro de .gz é bomba de descompressão, não pacote.',
          );
        }
        atual = desembrulhar(atual, formato, maxUncompressedBytes - gasto, maxUncompressedBytes);
        // O que o envelope produziu entra na conta e **não** sai dela quando as
        // entradas de dentro são lidas — o `.tar` materializado e as entradas
        // extraídas dele coexistem em memória, e é esse pico que o teto
        // dimensiona. O preço é uma assimetria medida: com o teto em 4 MiB, um
        // `.tar.gz` legítimo passa com 2040 KiB de conteúdo e é recusado com
        // 2048 KiB (~metade do teto), enquanto o mesmo conteúdo em `.zip`, que
        // não tem envelope, usa o teto inteiro — no padrão de 256 MiB, ~128 MiB
        // contra 256 MiB. É de propósito. Igualar os dois é voltar a contar o
        // teto por camada, e aí voltam os 653 MB de maxRSS para 250 MB de
        // conteúdo em `.tar.gz` que a nota do `gasto` acima mede.
        gasto += atual.byteLength;
        nome = semSufixoDeCompressao(nome);
        break;
      }

      default:
        // Nada reconhecido. Na primeira volta é um arquivo que não é pacote
        // nenhum; depois de um envelope é o caso legítimo do `SKILL.md.gz`, que
        // comprime um arquivo só e não tem estrutura dentro.
        if (desembrulhos === 0) {
          throw new ZipFormatError(
            'O arquivo enviado não é um pacote reconhecido: a assinatura não bate com ' +
              `nenhum formato aceito (${FORMATOS_ACEITOS}).`,
          );
        }
        return entradaUnica(nome, atual, maxEntries);
    }
  }
}

/** O limite em MB, do jeito que ele aparece nas mensagens do `zip.ts`. */
function emMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Abre um envelope de compressão com o zlib nativo do Node (o zstd está lá
 * desde o 22.15; as imagens são `node:24-alpine`).
 *
 * `maxOutputLength` é o que segura a bomba, e segura antes de alocar: 512 MB de
 * zeros viram 510 KB de gzip e 16 KB de zstd, e com o teto em 1 MB as duas
 * chamadas morrem em ~1 ms com `ERR_BUFFER_TOO_LARGE`, custando ~2 MB de RSS.
 * Sem ele, o buffer inteiro é materializado antes de qualquer conferência —
 * medir depois não adianta, o processo já caiu.
 *
 * O que entra no `maxOutputLength` é o **restante** do orçamento (ver `gasto`
 * em `extractArchive`); `teto` só aparece na mensagem, que é sobre o limite
 * configurado.
 */
function desembrulhar(
  buffer: Buffer,
  formato: 'gzip' | 'zstd',
  restante: number,
  teto: number,
): Buffer {
  // Sem orçamento não há o que abrir — e `maxOutputLength: 0` não serviria de
  // guarda: o zlib recusa o próprio valor (`ERR_OUT_OF_RANGE`), que viraria
  // "não foi possível descomprimir" no lugar da recusa por limite.
  if (restante <= 0) {
    throw new ZipLimitError(
      `O conteúdo descomprimido do pacote passa do limite de ${emMegabytes(teto)} MB.`,
    );
  }

  try {
    const opcoes = { maxOutputLength: restante };
    return formato === 'gzip' ? gunzipSync(buffer, opcoes) : zstdDecompressSync(buffer, opcoes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ZipLimitError(
        `O conteúdo descomprimido do pacote passa do limite de ${emMegabytes(teto)} MB.`,
      );
    }
    throw new ZipFormatError(
      `Não foi possível descomprimir o pacote (${formato}): ${(err as Error).message}`,
    );
  }
}

/**
 * Tira do nome o sufixo do envelope que acabou de ser aberto: `SKILL.md.gz`
 * vira `SKILL.md`. `.tgz` e `.tzst` são abreviação de `.tar.gz` e `.tar.zst`,
 * então o que sobra deles ainda é um `.tar` — na prática a redetecção já
 * resolve esses dois, e o nome só é usado quando dentro não havia pacote algum.
 *
 * `.zstd` e `.gzip` entram porque é assim que muita gente escreve, e o sufixo
 * desconhecido não dá erro: ele passa em silêncio. Medido: um `SKILL.md.zstd`
 * virava um envio com um único arquivo chamado `SKILL.md.zstd` — markdown já
 * descomprimido sob um nome que não é de markdown —, a rota respondia 201 e o
 * defeito só aparecia na promoção. O mesmo byte a byte como `.zst` funcionava.
 */
function semSufixoDeCompressao(nome: string): string {
  const minusculo = nome.toLowerCase();
  if (minusculo.endsWith('.tgz')) return `${nome.slice(0, -4)}.tar`;
  if (minusculo.endsWith('.tzst')) return `${nome.slice(0, -5)}.tar`;
  if (minusculo.endsWith('.gz')) return nome.slice(0, -3);
  if (minusculo.endsWith('.gzip')) return nome.slice(0, -5);
  if (minusculo.endsWith('.zst')) return nome.slice(0, -4);
  if (minusculo.endsWith('.zstd')) return nome.slice(0, -5);
  return nome;
}

/**
 * O envelope que não embrulhava pacote nenhum vira uma entrada só, com o nome
 * do envio sem o sufixo de compressão. O gzip até guarda um nome original no
 * cabeçalho, mas ele é opcional e some quando o arquivo passa por um proxy que
 * recomprime — o nome do envio é o que sempre existe.
 */
function entradaUnica(nome: string, data: Buffer, maxEntries: number): ArchiveEntry[] {
  if (maxEntries < 1) {
    throw new ZipLimitError(`O pacote tem entradas demais (1); o limite é ${maxEntries}.`);
  }

  // Só o nome do arquivo: o que vem antes da última barra é do disco de quem
  // enviou — o Safari e alguns clientes de upload mandam o caminho inteiro,
  // inclusive `C:\...`, e `normalizeRelativePath` recusaria o caminho absoluto.
  const base = nome.replace(/\\/g, '/').split('/').pop() ?? '';
  const path = normalizeRelativePath(base);
  // Sem nome aproveitável não há o que gravar. Quem chama trata a lista vazia
  // como "nenhuma skill no pacote", que é exatamente o que aconteceu.
  if (!path || isJunkPath(path) || isAppleDoubleFile(path, data)) return [];

  return [{ path, data }];
}

type LimitesDeLeitura = {
  maxUncompressedBytes: number;
  maxEntries: number;
  /** O que as camadas de envelope já materializaram (ver `extractArchive`). */
  gasto: number;
};

/**
 * Lê o `.zip` com o que **sobrou** do orçamento, mas recusa citando o **teto**.
 *
 * O `readZipEntries` é do `zip.ts` e aceita um número só, que ele usa para as
 * duas coisas: cortar a leitura e escrever a mensagem. Passar o restante é o
 * que impede o `.zip` dentro de um envelope de materializar o teto inteiro de
 * novo, e isso não muda — o que sai errado é a mensagem. Medido: um `.zip` com
 * 768 KiB de conteúdo incompressível dentro de um `.gz`, com o teto em 1 MiB,
 * era recusado com "passa do limite de 0 MB" — número que não está em
 * `ZIP_MAX_UNCOMPRESSED_BYTES` nem em lugar nenhum, e o contrário do que
 * `docs/15-quarentena.md` promete.
 *
 * A troca é feita deste lado porque `zip.ts` é de outro escopo. Só a recusa por
 * **bytes** é reescrita; a de entradas demais também é `ZipLimitError`, mas já
 * cita `maxEntries`, que vai inteiro. Sem envelope aberto (`gasto` zero) o
 * restante **é** o teto e a mensagem original já está certa, inclusive ao dizer
 * ".zip" — ali ele é o arquivo que o usuário enviou.
 */
function lerZipEntries(buffer: Buffer, limites: LimitesDeLeitura): ArchiveEntry[] {
  const { maxUncompressedBytes, maxEntries, gasto } = limites;

  try {
    return readZipEntries(buffer, {
      maxUncompressedBytes: maxUncompressedBytes - gasto,
      maxEntries,
    });
  } catch (err) {
    if (gasto > 0 && err instanceof ZipLimitError && err.message.includes('passa do limite')) {
      throw new ZipLimitError(
        `O conteúdo descomprimido do pacote passa do limite de ${emMegabytes(maxUncompressedBytes)} MB.`,
      );
    }
    throw err;
  }
}

/**
 * `typeflag '7'` (`contiguous-file`) é arquivo comum do GNU antigo, e some sem
 * aviso quando a régua é só `'file'`: medido, um `.tar` com o `SKILL.md`
 * gravado assim voltava com zero entradas e nenhuma mensagem.
 */
function ehArquivo(tipo: string | null): boolean {
  return tipo === 'file' || tipo === 'contiguous-file';
}

/**
 * Lê um `.tar` inteiro em memória com o `tar-stream`, que remonta sozinho o
 * cabeçalho estendido: o caminho longo sai pelo par `prefix` + `name` do ustar
 * até ~255 chars e, quando nenhum segmento cabe nos 100 bytes do campo `name`,
 * por um bloco pax (`typeflag` `x`) que ele funde na entrada seguinte — o
 * `.tar` de um repositório do GitHub chega com os dois casos.
 *
 * Mesma disciplina do `readZipEntries`: o `size` do cabeçalho é conferido antes
 * de materializar a entrada e os bytes que realmente chegaram são somados
 * depois, porque o cabeçalho é do arquivo enviado e pode mentir.
 *
 * Só entra arquivo (`file` e `contiguous-file`). Diretório não é arquivo de
 * skill; `symlink` e `link` gravados viariam um caminho apontando para fora do
 * envio, e o que eles apontam já está (ou não está) no pacote de qualquer jeito.
 */
function readTarEntries(buffer: Buffer, limites: LimitesDeLeitura): Promise<ArchiveEntry[]> {
  const { maxUncompressedBytes, maxEntries, gasto } = limites;

  return new Promise((resolve, reject) => {
    const parser = tarExtract();
    const entries: ArchiveEntry[] = [];
    // A conta começa no que os envelopes já materializaram: o teto é do pacote
    // inteiro, não de cada camada.
    let total = gasto;
    let contagem = 0;
    let falhou = false;

    // Rejeitar não para a leitura: sem o `destroy`, o parser seguiria abrindo o
    // resto do buffer — justamente o que o limite estourado quer evitar.
    const falhar = (erro: Error) => {
      if (falhou) return;
      falhou = true;
      parser.destroy();
      reject(erro);
    };
    const tooBig = () =>
      new ZipLimitError(
        `O conteúdo descomprimido do pacote passa do limite de ${emMegabytes(maxUncompressedBytes)} MB.`,
      );

    parser.on('entry', (header, stream, next) => {
      if (falhou) return;

      // Ouvinte de erro em **toda** entrada, antes de qualquer outra coisa —
      // não só na que vira arquivo. Sem ele, o tar que acaba antes do conteúdo
      // prometido por uma entrada não-`file` com `size > 0` (medido com
      // `typeflag '2'` e `'7'`) faz o `tar-stream` destruir a entrada com erro,
      // e o EventEmitter lança o `'error'` sem ouvinte num tick de stream —
      // fora da cadeia de Promises, fora do try/catch da rota. Como o admin não
      // registra `uncaughtException`, o processo imprime e sai: um upload
      // derruba o servidor.
      stream.on('error', (err: Error) => {
        falhar(new ZipFormatError(`Não foi possível ler "${header.name}" do pacote: ${err.message}`));
      });

      contagem += 1;
      if (contagem > maxEntries) {
        falhar(new ZipLimitError(`O pacote tem entradas demais; o limite é ${maxEntries}.`));
        return;
      }

      // A entrada que não interessa é descartada e o `next()` sai **na hora**,
      // sem esperar evento nenhum: o que faz a leitura andar é essa chamada, e
      // quem a faz somos nós. Esperar o `'end'` aqui — o exemplo clássico do
      // `tar-stream` — pendura a Promise para sempre quando o parser entrega a
      // entrada pelo ramo curto do `_consumeHeader` (`size === 0 || type ===
      // 'directory'`): lá ele não guarda a entrada em `_stream` nem conta os
      // bytes em `_missing`, e o `Source._read` só empurra o fim quando
      // `size === 0`. Medido no tar-stream 3.2.1 com um `.tar` de 1 KB cujo
      // único cabeçalho é `typeflag '5'` com `size = 1` (~70 bytes em .tar.gz):
      // o event loop esvazia e a Promise não resolve nem rejeita — a rota não
      // responde 400 nem 500 e segura o buffer do upload (até 64 MiB) até o
      // processo morrer.
      //
      // O `resume()` continua necessário para a entrada que o parser registrou
      // de verdade (um `symlink` com corpo, por exemplo): sem drenar, ele para
      // na contrapressão. Com ele, o corpo é descartado enquanto chega.
      //
      // O `next()` sai num microtask, e não aqui dentro, porque ele reentra no
      // `_update` do parser: chamado na pilha do `emit('entry')`, empilha um
      // quadro por entrada seguida. Medido, um `.tar` com 20 000 diretórios em
      // sequência — e o `.tar` de um repositório do GitHub é cheio deles —
      // morria com `RangeError: Maximum call stack size exceeded` num tick de
      // stream, que é a mesma morte de processo que o ouvinte de erro acima
      // existe para evitar.
      if (!ehArquivo(header.type)) {
        stream.resume();
        queueMicrotask(() => {
          if (!falhou) next();
        });
        return;
      }

      const declarado = header.size ?? 0;
      if (total + declarado > maxUncompressedBytes) {
        falhar(tooBig());
        return;
      }

      const partes: Uint8Array[] = [];
      let recebido = 0;
      stream.on('data', (parte: unknown) => {
        if (falhou) return;
        const bloco = parte as Uint8Array;
        recebido += bloco.byteLength;
        // O declarado acima é do arquivo enviado; a conta que vale é esta.
        if (total + recebido > maxUncompressedBytes) {
          falhar(tooBig());
          return;
        }
        partes.push(bloco);
      });
      stream.on('end', () => {
        if (falhou) return;
        total += recebido;
        const path = normalizeRelativePath(header.name);
        // O `Buffer.concat` é quem desgruda a entrada do pacote: o `tar-stream`
        // entrega janelas sobre o buffer de entrada (medido:
        // `parte.buffer === tar.buffer`) e o concat aloca e copia, mesmo com
        // uma parte só (medido no Node 24 da imagem e no 26 daqui). Devolver a
        // janela faria um SKILL.md de 4 bytes manter vivo o `.tar` inteiro de
        // onde saiu — a armadilha do `slice` do V8. O teste "as entradas não
        // apontam para o buffer do pacote" é o que segura isso.
        const data = Buffer.concat(partes);
        // O `._<nome>` do macOS vem solto no tar, ao lado do arquivo de
        // verdade, e não dentro de `__MACOSX/` como no .zip (ver
        // `isAppleDoubleFile`).
        if (path && !isJunkPath(path) && !isAppleDoubleFile(path, data)) {
          entries.push({ path, data });
        }
        next();
      });
    });

    parser.on('error', (err: Error) => {
      if (falhou) return;
      falhou = true;
      reject(new ZipFormatError(`O .tar não pôde ser lido (corrompido ou truncado): ${err.message}`));
    });
    parser.on('finish', () => resolve(entries));

    // O buffer inteiro de uma vez: ele já está em memória, e o `tar-stream`
    // consome no ritmo em que as entradas vão sendo drenadas.
    parser.end(buffer);
  });
}

/**
 * Caminho repetido: fica o primeiro, como no `extractZip`. Um `.tar` aceita a
 * mesma entrada duas vezes (é assim que `tar --append` grava uma atualização),
 * e `SKILL.md` com `skill.md` no mesmo diretório viram o mesmo caminho depois
 * de `normalizeRelativePath`.
 */
function primeiroVence(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
  const vistos = new Set<string>();
  const saida: ArchiveEntry[] = [];
  for (const entry of entries) {
    if (vistos.has(entry.path)) continue;
    vistos.add(entry.path);
    saida.push(entry);
  }
  return saida;
}
