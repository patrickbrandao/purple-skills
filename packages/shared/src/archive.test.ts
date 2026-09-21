import { gzipSync, zstdCompressSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import {
  ArchiveUnsupportedError,
  DEFAULT_MAX_BUNDLE_ENTRIES,
  detectArchiveFormat,
  extractArchive,
} from './archive.js';
import { DEFAULT_MAX_ZIP_ENTRIES, ZipError, ZipFormatError, ZipLimitError, extractZip } from './zip.js';

function makeZip(entries: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

/**
 * Um ZIP com os caminhos gravados **como vieram**, sem passar pelo saneamento
 * do `adm-zip`.
 *
 * Medido: `addFile('../../etc/passwd')` grava `etc/passwd`, e `addFile('/x')`
 * grava `x` — um teste de travessia montado com ele não testa nada, porque o
 * `.zip` nunca chega a ter o caminho perigoso. Atribuir `entryName` depois
 * escapa do saneamento e produz o arquivo que um atacante mandaria.
 */
function zipComCaminhoCru(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  const nomes = Object.keys(entries);
  for (const [i, nome] of nomes.entries()) zip.addFile(`e${i}`, Buffer.from(entries[nome], 'utf8'));
  for (const [i, entry] of zip.getEntries().entries()) entry.entryName = nomes[i];
  return zip.toBuffer();
}

type EntradaTar = {
  name: string;
  content?: Buffer | string;
  type?: 'file' | 'directory' | 'symlink' | 'contiguous-file';
  linkname?: string;
};

/** Gera um `.tar` de verdade — o `pack` do `tar-stream` é o mesmo que o `tar` grava. */
async function makeTar(entradas: readonly EntradaTar[]): Promise<Buffer> {
  const empacotador = pack();
  for (const entrada of entradas) {
    const data = Buffer.isBuffer(entrada.content)
      ? entrada.content
      : Buffer.from(entrada.content ?? '', 'utf8');
    empacotador.entry(
      { name: entrada.name, type: entrada.type ?? 'file', linkname: entrada.linkname },
      data,
    );
  }
  empacotador.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of empacotador) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const BLOCO_TAR = 512;

/**
 * Um cabeçalho tar de 512 bytes montado campo a campo, que é a única forma de
 * escrever combinações que nenhum empacotador honesto produz — `typeflag '5'`
 * com `size` maior que zero, `typeflag '2'` com corpo — e que são justamente as
 * que quebravam a leitura. O `pack` do `tar-stream` não as gera: ele zera o
 * `size` do symlink e recusa o corpo que não bate com o cabeçalho.
 *
 * Nenhum byte de controle literal: o bloco nasce zerado do `Buffer.alloc` e só
 * recebe ASCII (ver `AGENTS.md`).
 */
function cabecalhoTarCru(nome: string, typeflag: string, size: number): Buffer {
  const bloco = Buffer.alloc(BLOCO_TAR);
  bloco.write(nome, 0, 'ascii'); // name[100]
  bloco.write('000644 ', 100, 'ascii'); // mode[8]
  bloco.write('000000 ', 108, 'ascii'); // uid[8]
  bloco.write('000000 ', 116, 'ascii'); // gid[8]
  bloco.write(`${size.toString(8).padStart(11, '0')} `, 124, 'ascii'); // size[12], octal
  bloco.write('00000000000 ', 136, 'ascii'); // mtime[12]
  bloco.write(typeflag, 156, 'ascii');
  bloco.write('ustar', 257, 'ascii'); // magic[6] — o NUL do fim já está lá
  bloco.write('00', 263, 'ascii'); // version[2]

  // A soma trata o próprio campo do checksum como oito espaços, como manda o
  // formato (e como o `headers.js` do tar-stream confere).
  let soma = 8 * 32;
  for (let i = 0; i < 148; i += 1) soma += bloco[i];
  for (let i = 156; i < BLOCO_TAR; i += 1) soma += bloco[i];
  bloco.write(`${soma.toString(8).padStart(6, '0')} `, 148, 'ascii');

  return bloco;
}

/**
 * Falha em vez de pendurar.
 *
 * Uma Promise que nunca resolve nem rejeita não "dá erro": ela some, e o teste
 * só morre no prazo do Vitest, com uma mensagem que não diz o que aconteceu —
 * exatamente o que o defeito fazia com a requisição do usuário.
 */
async function comPrazo<T>(promessa: Promise<T>, rotulo: string, ms = 2000): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(
      () => rejeitar(new Error(`${rotulo}: a Promise não resolveu nem rejeitou em ${ms} ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promessa, prazo]);
  } finally {
    clearTimeout(temporizador);
  }
}

/** Resolveu, recusou com erro do pacote (400) ou algo que viraria 500. */
async function veredito(promessa: Promise<unknown>, rotulo: string): Promise<string> {
  return comPrazo(
    promessa.then(
      () => 'resolveu',
      (erro: unknown) =>
        erro instanceof ZipError ? 'recusou' : `erro não tipado: ${(erro as Error).name}`,
    ),
    rotulo,
  );
}

/**
 * A assinatura do bzip2 inteira: `BZh`, o dígito de nível e o magic do primeiro
 * bloco (os dígitos de π em BCD, `1AY&SY` em ASCII).
 */
const ASSINATURA_BZIP2 = [0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59];

/**
 * Um AppleDouble como o `tar` do macOS grava: o magic 00 05 16 07 e o resto do
 * cabeçalho de atributos estendidos, que aqui não precisa fazer sentido.
 */
function appleDouble(): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x05, 0x16, 0x07]), Buffer.alloc(60)]);
}

/** Um arquivo com a assinatura de um formato e nada de útil depois dela. */
function comAssinatura(bytes: readonly number[]): Buffer {
  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(600, 0x41)]);
}

/**
 * Bytes que não comprimem, de um xorshift de 32 bits — determinístico, para o
 * teste não depender de sorte.
 *
 * Conteúdo repetitivo não serve para medir orçamento de envelope: medido, 768
 * KiB de `Buffer.alloc` viram um `.zip` de 19 KiB, o `.gz` de fora desconta
 * esses 19 KiB do teto e não sobra assimetria nenhuma para o teste enxergar —
 * ele passaria com ou sem a correção. O mesmo tamanho em ruído dá um `.zip` de
 * 768 KiB, que é o que o envelope tem de gastar de verdade.
 */
function ruido(tamanho: number): Buffer {
  const buffer = Buffer.alloc(tamanho);
  let estado = 0x9e3779b9;
  for (let i = 0; i < tamanho; i += 1) {
    estado ^= estado << 13;
    estado ^= estado >>> 17;
    estado ^= estado << 5;
    buffer[i] = estado & 0xff;
  }
  return buffer;
}

const caminhos = (entries: readonly { path: string }[]) => entries.map((e) => e.path).sort();

describe('detectArchiveFormat', () => {
  it('reconhece cada formato pela assinatura', () => {
    expect(detectArchiveFormat(makeZip({ 'SKILL.md': '# a' }))).toBe('zip');
    expect(detectArchiveFormat(gzipSync(Buffer.from('oi')))).toBe('gzip');
    expect(detectArchiveFormat(zstdCompressSync(Buffer.from('oi')))).toBe('zstd');
    expect(detectArchiveFormat(comAssinatura([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe('rar');
    expect(detectArchiveFormat(comAssinatura([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))).toBe('rar');
    expect(detectArchiveFormat(comAssinatura([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
    expect(detectArchiveFormat(comAssinatura([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))).toBe('xz');
    expect(detectArchiveFormat(comAssinatura(ASSINATURA_BZIP2))).toBe('bzip2');
    expect(detectArchiveFormat(Buffer.from('isto é um texto solto'))).toBe('unknown');
    expect(detectArchiveFormat(Buffer.alloc(0))).toBe('unknown');
  });

  it('reconhece o zip vazio e o dividido, que não começam com a assinatura comum', () => {
    // `PK` 05 06 é o .zip sem nenhuma entrada (só o fim do diretório central) e
    // `PK` 07 08 abre um volume de .zip dividido. Recusá-los como "não é zip"
    // daria "arquivo corrompido" onde a resposta certa é "pacote vazio".
    expect(detectArchiveFormat(comAssinatura([0x50, 0x4b, 0x05, 0x06]))).toBe('zip');
    expect(detectArchiveFormat(comAssinatura([0x50, 0x4b, 0x07, 0x08]))).toBe('zip');
  });

  it('decide pelo conteúdo, não pela extensão: um .skill é um ZIP e um .rar renomeado continua RAR', async () => {
    const skill = makeZip({ 'SKILL.md': '# a' });
    expect(detectArchiveFormat(skill)).toBe('zip');
    expect(caminhos(await extractArchive(skill, 'pacote.skill'))).toEqual(['SKILL.md']);

    // O mesmo buffer com nome de .zip: a extensão não muda o veredito.
    const rar = comAssinatura([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
    expect(detectArchiveFormat(rar)).toBe('rar');
    await expect(extractArchive(rar, 'skills.zip')).rejects.toThrow(ArchiveUnsupportedError);
  });

  it('não chama de tar um buffer curto com `ustar` por acaso no offset 257', async () => {
    // O tar só tem o `magic` no meio do primeiro bloco: sem exigir o bloco
    // inteiro, qualquer arquivo com essas cinco letras naquele ponto viraria
    // pacote — e a leitura falharia depois, com a mensagem errada.
    const curto = Buffer.alloc(300);
    curto.write('ustar', 257, 'ascii');
    expect(detectArchiveFormat(curto)).toBe('unknown');

    const bloco = Buffer.alloc(512);
    bloco.write('ustar', 257, 'ascii');
    expect(detectArchiveFormat(bloco)).toBe('tar');

    expect(detectArchiveFormat(await makeTar([{ name: 'SKILL.md', content: '# a' }]))).toBe('tar');
  });

  it('não confunde com bzip2 o .tar cujo primeiro arquivo começa com "BZh"', async () => {
    // O começo do .tar é o nome do primeiro membro, e `BZh` sozinho era
    // assinatura bastante para recusar o pacote: um `.tar` perfeito voltava
    // como "está em bzip2, um formato que este servidor não abre".
    const notas = await makeTar([{ name: 'BZh-notas.md', content: '# notas' }]);
    expect(detectArchiveFormat(notas)).toBe('tar');
    expect(caminhos(await extractArchive(notas, 'notas.tar'))).toEqual(['BZh-notas.md']);

    // E mesmo o nome que copia a assinatura inteira perde para o `ustar` do
    // offset 257, que é estrutura do formato e não conteúdo do usuário.
    const imitacao = await makeTar([{ name: 'BZh91AY&SY-notas.md', content: '# notas' }]);
    expect(imitacao.subarray(0, 10).equals(Buffer.from(ASSINATURA_BZIP2))).toBe(true);
    expect(detectArchiveFormat(imitacao)).toBe('tar');
  });

  it('o bzip2 de verdade continua reconhecido, e "BZh" solto não é bzip2', () => {
    expect(detectArchiveFormat(comAssinatura(ASSINATURA_BZIP2))).toBe('bzip2');
    // Fim de fluxo no lugar do bloco: é o .bz2 que não comprimiu nada.
    expect(
      detectArchiveFormat(
        comAssinatura([0x42, 0x5a, 0x68, 0x31, 0x17, 0x72, 0x45, 0x38, 0x50, 0x90]),
      ),
    ).toBe('bzip2');

    // Sem o dígito de nível e sem o magic do bloco não é bzip2 nenhum.
    expect(detectArchiveFormat(comAssinatura([0x42, 0x5a, 0x68]))).toBe('unknown');
    expect(detectArchiveFormat(comAssinatura([0x42, 0x5a, 0x68, 0x39]))).toBe('unknown');
  });
});

describe('extractArchive — zip', () => {
  it('devolve os caminhos inteiros: quem corta prefixo é o splitBundle', async () => {
    // O .zip do GitHub traz tudo embaixo de `<repo>-main/`, e é esse prefixo
    // que separa uma skill da outra. `extractZip` desembrulha a pasta raiz
    // única; aqui isso seria justamente perder a informação.
    const entries = await extractArchive(
      makeZip({
        'superpowers-main/skills/brainstorming/SKILL.md': '# brainstorming',
        'superpowers-main/skills/debugging/SKILL.md': '# debugging',
        'superpowers-main/README.md': '# leia',
      }),
      'superpowers-main.zip',
    );

    expect(caminhos(entries)).toEqual([
      'superpowers-main/README.md',
      'superpowers-main/skills/brainstorming/SKILL.md',
      'superpowers-main/skills/debugging/SKILL.md',
    ]);
  });

  it('descarta a travessia de diretório e desarma o caminho absoluto', async () => {
    const entries = await extractArchive(
      zipComCaminhoCru({
        '../../etc/passwd': 'raiz:x:0:0',
        'skills/../../fora.md': '# fora',
        '/etc/shadow': 'x',
        'SKILL.md': '# ok',
      }),
      'pacote.zip',
    );

    // As duas travessias somem. O caminho absoluto não some: `/etc/shadow`
    // perde a barra da frente e vira `etc/shadow`, um arquivo comum dentro do
    // envio — é o que `normalizeRelativePath` faz, e o que importa é que nada
    // saia da raiz do pacote.
    expect(caminhos(entries)).toEqual(['SKILL.md', 'etc/shadow']);
    for (const entry of entries) {
      expect(entry.path.startsWith('/')).toBe(false);
      expect(entry.path.split('/')).not.toContain('..');
    }
  });

  it('descarta o lixo de sistema operacional em qualquer segmento', async () => {
    const entries = await extractArchive(
      makeZip({
        'SKILL.md': '# ok',
        '__MACOSX/._SKILL.md': 'x',
        'skills/a/__MACOSX/lixo': 'x',
        '.DS_Store': 'y',
        'skills/a/.DS_Store': 'y',
        'Thumbs.db': 'z',
      }),
      'pacote.zip',
    );

    expect(caminhos(entries)).toEqual(['SKILL.md']);
  });

  it('descarta o AppleDouble solto, que no .zip costuma vir dentro de __MACOSX/', async () => {
    const entries = await extractArchive(
      makeZip({
        'SKILL.md': '# ok',
        '._SKILL.md': appleDouble(),
        '__MACOSX/._logo.png': appleDouble(),
      }),
      'pacote.zip',
    );

    expect(caminhos(entries)).toEqual(['SKILL.md']);
  });

  it('caminho repetido: fica o primeiro', async () => {
    // `SKILL.md` e `skill.md` viram o mesmo caminho depois da canonização de
    // `normalizeRelativePath` — é o mesmo desempate do `extractZip`.
    const entries = await extractArchive(
      makeZip({ 'SKILL.md': '# primeiro', 'skill.md': '# segundo' }),
      'pacote.zip',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].data.toString('utf8')).toBe('# primeiro');
  });

  it('recusa quando há entradas demais', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) entries[`f${i}.md`] = 'x';

    await expect(extractArchive(makeZip(entries), 'pacote.zip', { maxEntries: 5 })).rejects.toThrow(
      ZipLimitError,
    );
  });

  it('o teto de entradas do bundle é bem maior que o de uma skill avulsa', () => {
    // 512 entradas é o pacote de uma skill; um repositório do GitHub passa
    // disso só com `.github/` e `docs/`.
    expect(DEFAULT_MAX_BUNDLE_ENTRIES).toBe(20_000);
    expect(DEFAULT_MAX_BUNDLE_ENTRIES).toBeGreaterThan(DEFAULT_MAX_ZIP_ENTRIES);
  });
});

describe('extractArchive — tar', () => {
  it('lê um tar simples e ignora diretório e symlink', async () => {
    const tar = await makeTar([
      { name: 'skills/', type: 'directory' },
      { name: 'skills/a/SKILL.md', content: '# a' },
      { name: 'skills/a/ref/nota.md', content: '# nota' },
      { name: 'skills/a/atalho', type: 'symlink', linkname: '../../etc/passwd' },
    ]);

    const entries = await extractArchive(tar, 'skills.tar');

    // O symlink fica de fora: gravá-lo seria guardar um caminho que aponta para
    // fora do envio, e o que ele aponta já está (ou não está) no pacote.
    expect(caminhos(entries)).toEqual(['skills/a/SKILL.md', 'skills/a/ref/nota.md']);
    expect(entries.find((e) => e.path === 'skills/a/SKILL.md')?.data.toString('utf8')).toBe('# a');
  });

  it('o diretório que declara conteúdo não pendura a leitura para sempre', async () => {
    // O pacote inteiro: um cabeçalho `typeflag '5'` com `size = 1` e o bloco de
    // fim de arquivo. São 1 KB, ~70 bytes depois de um gzip.
    //
    // Enquanto a entrada descartada esperava o `'end'`, este envio travava a
    // Promise de `extractArchive` **para sempre** — medido: o event loop
    // esvazia (zero handles, zero requests) com a Promise pendente. Na rota
    // isso é a requisição que não recebe 400 nem 500 e segura o buffer do
    // upload; não é lentidão, é a resposta que nunca sai.
    const tar = Buffer.concat([cabecalhoTarCru('x/', '5', 1), Buffer.alloc(BLOCO_TAR)]);
    expect(tar).toHaveLength(1024);

    await expect(comPrazo(extractArchive(tar, 'pacote.tar'), 'diretório com size')).resolves.toEqual(
      [],
    );
  });

  it('nenhum typeflag, com nenhum size declarado, deixa a Promise pendente', async () => {
    // A regra não é sobre diretório: é sobre quem faz a leitura andar. O
    // `next()` é nosso, então toda entrada avança ou falha — qualquer
    // `typeflag`, com corpo ou sem, com o `size` batendo ou mentindo.
    const typeflags = ['0', '1', '2', '3', '4', '5', '6', '7', 'g', 'x'];
    const corpo = Buffer.alloc(BLOCO_TAR, 0x41);
    const fim = Buffer.alloc(2 * BLOCO_TAR);
    const vereditos: Record<string, string> = {};

    for (const typeflag of typeflags) {
      const comCorpo = Buffer.concat([cabecalhoTarCru('x', typeflag, 4), corpo, fim]);
      const semCorpo = Buffer.concat([cabecalhoTarCru('x', typeflag, 4), fim]);
      const mentindo = Buffer.concat([cabecalhoTarCru('x', typeflag, 99_999), corpo, fim]);

      vereditos[typeflag] = [
        await veredito(extractArchive(comCorpo, 'pacote.tar'), `typeflag ${typeflag} com corpo`),
        await veredito(extractArchive(semCorpo, 'pacote.tar'), `typeflag ${typeflag} sem corpo`),
        await veredito(extractArchive(mentindo, 'pacote.tar'), `typeflag ${typeflag} mentindo`),
      ].join(' ');
    }

    // Resolver ou recusar, as duas respostas servem — o que não pode é não
    // haver resposta, e nada pode escapar como erro não tipado, que a borda
    // HTTP transformaria em 500.
    const respondeu = /^(resolveu|recusou) (resolveu|recusou) (resolveu|recusou)$/;
    expect(vereditos).toEqual(
      Object.fromEntries(typeflags.map((typeflag) => [typeflag, expect.stringMatching(respondeu)])),
    );
  });

  it('milhares de entradas descartadas seguidas não estouram a pilha', async () => {
    // O `next()` reentra no `_update` do parser: chamado dentro da pilha do
    // `emit('entry')`, empilha um quadro por entrada seguida. Medido, um `.tar`
    // com 20 000 diretórios em sequência — e o `.tar` de um repositório do
    // GitHub é cheio de diretórios — morria com `RangeError: Maximum call stack
    // size exceeded` num tick de stream: morte de processo, não recusa. Com
    // ouvinte de `uncaughtException` instalado, o mesmo defeito vira a Promise
    // pendente, e é por isso que este teste vigia as duas coisas.
    const diretorios = Array.from({ length: 4000 }, (_, i) => ({
      name: `d${i}/`,
      type: 'directory' as const,
    }));
    const tar = await makeTar([...diretorios, { name: 'SKILL.md', content: '# ok' }]);

    const escaparam: Error[] = [];
    const capturar = (erro: Error) => escaparam.push(erro);
    process.on('uncaughtException', capturar);

    try {
      const entries = await comPrazo(extractArchive(tar, 'repo.tar'), '4 000 diretórios');
      expect(caminhos(entries)).toEqual(['SKILL.md']);
    } finally {
      process.off('uncaughtException', capturar);
    }

    expect(escaparam.map((erro) => erro.message)).toEqual([]);
  });

  it('tar truncado numa entrada que não é arquivo recusa, em vez de derrubar o processo', async () => {
    // `typeflag '2'` (symlink) e `'7'` (contiguous-file) com `size > 0` são
    // entregues pelo ramo que o parser registra de verdade: quando o tar acaba
    // antes do conteúdo prometido, ele destrói a entrada **com erro**. Sem
    // ouvinte de `'error'` nessa entrada, o EventEmitter lança fora da cadeia
    // de Promises ("Emitted 'error' event on Source instance") — e como o admin
    // não registra `uncaughtException`, o processo imprimia e saía: um upload
    // derrubava o servidor.
    //
    // A recusa sozinha não prova nada: o `'error'` do parser continua chegando
    // e a Promise rejeita **enquanto** a exceção mata o processo por fora. O
    // que este teste vigia é o `uncaughtException` — sem ouvinte na entrada,
    // ele aparece; com ouvinte, a lista fica vazia.
    const escaparam: Error[] = [];
    const capturar = (erro: Error) => escaparam.push(erro);
    process.on('uncaughtException', capturar);

    try {
      for (const typeflag of ['2', '7']) {
        const truncado = Buffer.concat([
          cabecalhoTarCru('atalho', typeflag, 600),
          Buffer.alloc(10, 0x41),
        ]);

        await expect(
          comPrazo(extractArchive(truncado, 'pacote.tar'), `typeflag ${typeflag}`),
        ).rejects.toThrow(ZipFormatError);
        // A exceção nasce num tick de stream, depois da rejeição.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      process.off('uncaughtException', capturar);
    }

    expect(escaparam.map((erro) => erro.message)).toEqual([]);
  });

  it('o mesmo tar hostil dentro de .gz e de .zst também recusa, sem pendurar nem derrubar', async () => {
    // O teste acima manda o `.tar` cru, e é o único caminho que os cabeçalhos
    // montados à mão exercitavam — mas o que o usuário manda de verdade é
    // `.tar.gz`. Pelo envelope, o leitor de tar recebe outro buffer (o que saiu
    // do `gunzip`) e um orçamento já descontado, então a proteção precisa valer
    // dos dois lados: a entrada não-`file` truncada não pode escapar como
    // `uncaughtException` (morte do processo) nem deixar a Promise pendente
    // (requisição sem resposta, segurando o buffer do upload).
    const escaparam: Error[] = [];
    const capturar = (erro: Error) => escaparam.push(erro);
    process.on('uncaughtException', capturar);

    try {
      for (const [sufixo, comprimir] of [
        ['gz', gzipSync],
        ['zst', zstdCompressSync],
      ] as const) {
        for (const typeflag of ['2', '7']) {
          const truncado = Buffer.concat([
            cabecalhoTarCru('atalho', typeflag, 600),
            Buffer.alloc(10, 0x41),
          ]);

          await expect(
            comPrazo(
              extractArchive(comprimir(truncado), `pacote.tar.${sufixo}`),
              `typeflag ${typeflag} em .${sufixo}`,
            ),
          ).rejects.toThrow(ZipFormatError);
          // A exceção nasce num tick de stream, depois da rejeição.
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        // O outro cabeçalho que nenhum empacotador honesto gera: o diretório
        // que declara conteúdo, que pendurava a Promise em vez de derrubar o
        // processo. Resolve com zero entradas, como no `.tar` cru.
        const diretorioComCorpo = Buffer.concat([
          cabecalhoTarCru('x/', '5', 1),
          Buffer.alloc(BLOCO_TAR),
        ]);

        await expect(
          comPrazo(
            extractArchive(comprimir(diretorioComCorpo), `pacote.tar.${sufixo}`),
            `diretório com size em .${sufixo}`,
          ),
        ).resolves.toEqual([]);
      }
    } finally {
      process.off('uncaughtException', capturar);
    }

    expect(escaparam.map((erro) => erro.message)).toEqual([]);
  });

  it('contiguous-file é arquivo: o typeflag 7 do GNU antigo não é descartado', async () => {
    // É arquivo comum gravado no formato GNU antigo. Com a régua em `'file'`
    // ele sumia sem aviso — o pacote voltava sem o `SKILL.md` e a mensagem
    // falava em "nenhuma skill", que manda procurar o defeito no lugar errado.
    const entries = await extractArchive(
      await makeTar([
        { name: 'skills/a/SKILL.md', type: 'contiguous-file', content: '# a' },
        { name: 'skills/a/ref/nota.md', content: '# nota' },
      ]),
      'skills.tar',
    );

    expect(caminhos(entries)).toEqual(['skills/a/SKILL.md', 'skills/a/ref/nota.md']);
    expect(entries.find((e) => e.path === 'skills/a/SKILL.md')?.data.toString('utf8')).toBe('# a');
  });

  it('devolve inteiro o caminho longo, pelo prefixo do ustar e pelo bloco pax', async () => {
    // Dois mecanismos diferentes, e o `tar-stream` resolve os dois sozinho:
    // até ~255 chars o nome é partido entre os campos `prefix` e `name` (o
    // typeflag continua `0`); quando nenhum segmento cabe nos 100 bytes do
    // `name` — medido com um diretório de 120 chars — o `tar` grava antes um
    // bloco pax (typeflag `x`) que o leitor funde na entrada seguinte.
    const porPrefixo = `skills/${'n'.repeat(80)}/${'sub'.repeat(10)}/SKILL.md`;
    const porPax = `skills/${'z'.repeat(120)}/SKILL.md`;
    expect(porPrefixo.length).toBeGreaterThan(100);

    const entries = await extractArchive(
      await makeTar([
        { name: porPrefixo, content: '# prefixo' },
        { name: porPax, content: '# pax' },
      ]),
      'longos.tar',
    );

    expect(caminhos(entries)).toEqual([porPax, porPrefixo].sort());
    expect(entries.find((e) => e.path === porPax)?.data.toString('utf8')).toBe('# pax');
  });

  it('descarta travessia e lixo de sistema operacional, como no zip', async () => {
    const entries = await extractArchive(
      await makeTar([
        { name: '../../etc/passwd', content: 'raiz:x:0:0' },
        { name: '__MACOSX/._SKILL.md', content: 'x' },
        { name: 'skills/a/.DS_Store', content: 'y' },
        { name: 'SKILL.md', content: '# ok' },
      ]),
      'pacote.tar',
    );

    expect(caminhos(entries)).toEqual(['SKILL.md']);
  });

  it('descarta o AppleDouble que o tar do macOS grava ao lado de cada arquivo', async () => {
    // Medido na verificação da importação: o `.tar.gz` de uma coleção feita num
    // Mac voltou com `._SKILL.md`, `._diagrama.png` e `ref/._tecnicas.md` junto
    // dos arquivos de verdade. No `.zip` esse metadado vai para `__MACOSX/` e
    // já saía; no tar ele vem solto, ao lado do arquivo.
    const entries = await extractArchive(
      await makeTar([
        { name: 'skills/a/SKILL.md', content: '# a' },
        { name: 'skills/a/._SKILL.md', content: appleDouble() },
        { name: 'skills/a/._ref', content: appleDouble() },
        { name: 'skills/a/ref/tecnicas.md', content: '# técnicas' },
        { name: 'skills/a/ref/._tecnicas.md', content: appleDouble() },
      ]),
      'skills.tar.gz',
    );

    expect(caminhos(entries)).toEqual(['skills/a/SKILL.md', 'skills/a/ref/tecnicas.md']);
  });

  it('não descarta pelo nome: um `._config` de verdade sobrevive', async () => {
    // A régua é a assinatura, não o prefixo. `._config` é nome legítimo, e
    // descartá-lo por heurística apagaria um arquivo do usuário sem aviso.
    const entries = await extractArchive(
      await makeTar([
        { name: 'SKILL.md', content: '# a' },
        { name: '._config', content: 'porta=8080' },
        { name: '._logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]),
      'pacote.tar',
    );

    expect(caminhos(entries)).toEqual(['SKILL.md', '._config', '._logo.png'].sort());
  });

  it('recusa um tar corrompido com erro tipado, não genérico', async () => {
    const tar = await makeTar([{ name: 'SKILL.md', content: '# ok' }]);
    // Um bloco de 512 bytes com o `magic` no lugar e o resto sem sentido: passa
    // na detecção e morre no checksum do cabeçalho.
    const falso = Buffer.alloc(1024, 0x41);
    falso.write('ustar', 257, 'ascii');

    await expect(extractArchive(falso, 'pacote.tar')).rejects.toThrow(ZipFormatError);
    // A borda HTTP trata `ZipError` como 400; um Error solto viraria 500.
    await expect(extractArchive(falso, 'pacote.tar')).rejects.toThrow(ZipError);
    // Truncado no meio de uma entrada: o cabeçalho promete bytes que não vieram.
    await expect(extractArchive(tar.subarray(0, 700), 'pacote.tar')).rejects.toThrow(ZipFormatError);
  });

  it('recusa quando há entradas demais', async () => {
    const entradas = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.md`, content: 'x' }));

    await expect(
      extractArchive(await makeTar(entradas), 'pacote.tar', { maxEntries: 5 }),
    ).rejects.toThrow(ZipLimitError);
  });

  it('recusa quando o conteúdo passa do teto', async () => {
    const tar = await makeTar([
      { name: 'SKILL.md', content: '# ok' },
      { name: 'bomba.bin', content: Buffer.alloc(2 * 1024 * 1024) },
    ]);

    await expect(
      extractArchive(tar, 'pacote.tar', { maxUncompressedBytes: 1024 * 1024 }),
    ).rejects.toThrow(ZipLimitError);
  });

  it('as entradas não apontam para o buffer do pacote', async () => {
    // O `tar-stream` entrega janelas sobre o buffer de entrada (medido:
    // `parte.buffer === tar.buffer`); quem as desgruda é o `Buffer.concat`.
    // Devolver a janela faria um SKILL.md de 4 bytes manter vivo o `.tar` de
    // 256 KB de onde saiu — a armadilha do `slice` do V8, que já custou +400 MB
    // de heap neste projeto uma vez.
    const tar = await makeTar([
      { name: 'SKILL.md', content: '# ok' },
      { name: 'peso.bin', content: Buffer.alloc(256 * 1024, 7) },
    ]);
    const entries = await extractArchive(tar, 'pacote.tar');
    const principal = entries.find((e) => e.path === 'SKILL.md');

    expect(principal?.data.toString('utf8')).toBe('# ok');
    expect(principal?.data.buffer).not.toBe(tar.buffer);
    // E o conteúdo é de verdade uma cópia: mexer no pacote não muda a entrada.
    tar.fill(0);
    expect(principal?.data.toString('utf8')).toBe('# ok');
  });
});

describe('extractArchive — envelopes de compressão', () => {
  it('abre .tar.gz e .tar.zst e segue lendo o tar de dentro', async () => {
    const tar = await makeTar([
      { name: 'skills/a/SKILL.md', content: '# a' },
      { name: 'skills/b/SKILL.md', content: '# b' },
    ]);
    const esperado = ['skills/a/SKILL.md', 'skills/b/SKILL.md'];

    expect(caminhos(await extractArchive(gzipSync(tar), 'skills.tar.gz'))).toEqual(esperado);
    expect(caminhos(await extractArchive(gzipSync(tar), 'skills.tgz'))).toEqual(esperado);
    expect(caminhos(await extractArchive(zstdCompressSync(tar), 'skills.tar.zst'))).toEqual(esperado);
    expect(caminhos(await extractArchive(zstdCompressSync(tar), 'skills.tzst'))).toEqual(esperado);
  });

  it('o .gz de um arquivo só vira uma entrada, com o nome sem o sufixo', async () => {
    const gz = await extractArchive(gzipSync(Buffer.from('# Skill', 'utf8')), 'SKILL.md.gz');
    expect(gz).toHaveLength(1);
    expect(gz[0].path).toBe('SKILL.md');
    expect(gz[0].data.toString('utf8')).toBe('# Skill');

    const zst = await extractArchive(zstdCompressSync(Buffer.from('nota', 'utf8')), 'ref/nota.md.zst');
    // Só o nome do arquivo: o diretório é do disco de quem enviou.
    expect(zst.map((e) => e.path)).toEqual(['nota.md']);

    // A canonização do `SKILL.md` vale aqui também (ver `paths.ts`).
    const caixaBaixa = await extractArchive(gzipSync(Buffer.from('# a')), 'skill.md.gz');
    expect(caixaBaixa.map((e) => e.path)).toEqual(['SKILL.md']);
  });

  it('`.zstd` e `.gzip` são sufixo de compressão, como `.zst` e `.gz`', async () => {
    // O sufixo que o código não conhece não dá erro: passa em silêncio. Um
    // `SKILL.md.zstd` virava um envio com um único arquivo chamado
    // `SKILL.md.zstd` — markdown já descomprimido sob nome que não é de
    // markdown —, a rota respondia 201 e o defeito só aparecia na promoção,
    // enquanto o mesmo byte a byte como `.zst` funcionava.
    const zstd = await extractArchive(zstdCompressSync(Buffer.from('# Skill')), 'SKILL.md.zstd');
    expect(zstd.map((e) => e.path)).toEqual(['SKILL.md']);
    expect(zstd[0].data.toString('utf8')).toBe('# Skill');

    const gzip = await extractArchive(gzipSync(Buffer.from('nota')), 'ref/nota.md.gzip');
    expect(gzip.map((e) => e.path)).toEqual(['nota.md']);

    // E o `.tar.zstd` continua sendo lido como tar: quem decide é a assinatura.
    const tar = await makeTar([{ name: 'SKILL.md', content: '# ok' }]);
    expect(caminhos(await extractArchive(zstdCompressSync(tar), 'skills.tar.zstd'))).toEqual([
      'SKILL.md',
    ]);
  });

  it('o teto é do pacote inteiro: cada camada desconta do mesmo orçamento', async () => {
    // O mesmo conteúdo era materializado uma vez por camada e conferido contra
    // o teto cheio em todas elas. Medido com maxRSS no Node 26, 250 MB de
    // conteúdo custavam 346 MB em `.zip`, 653 MB em `.tar.gz` e 871 MB em
    // gzip(gzip(tar)) — contra os "~2x o teto descomprimido + 200 MB" com que o
    // `docker-compose.yml` dimensiona o container.
    const tar = await makeTar([
      { name: 'SKILL.md', content: '# ok' },
      { name: 'peso.bin', content: Buffer.alloc(3 * 1024 * 1024, 7) },
    ]);
    const teto = 4 * 1024 * 1024;

    // Cru, o mesmo conteúdo cabe: são ~3 MB de um teto de 4 MB.
    expect(caminhos(await extractArchive(tar, 'pacote.tar', { maxUncompressedBytes: teto }))).toEqual(
      ['SKILL.md', 'peso.bin'],
    );

    // Dentro de um envelope, não: o `.gz` já gastou 3 MB do orçamento ao
    // produzir o tar, e as entradas pedem outros 3 MB.
    await expect(
      extractArchive(gzipSync(tar), 'pacote.tar.gz', { maxUncompressedBytes: teto }),
    ).rejects.toThrow(ZipLimitError);
    await expect(
      extractArchive(zstdCompressSync(zstdCompressSync(tar)), 'pacote.tar.zst', {
        maxUncompressedBytes: teto,
      }),
    ).rejects.toThrow(ZipLimitError);

    // A mensagem cita o limite configurado, não o resto da conta: quem lê
    // precisa reconhecer o número que ele mesmo pôs em `ZIP_MAX_UNCOMPRESSED_BYTES`.
    await expect(
      extractArchive(gzipSync(tar), 'pacote.tar.gz', { maxUncompressedBytes: teto }),
    ).rejects.toThrow('limite de 4 MB');

    // Com orçamento para as duas etapas, o mesmo `.tar.gz` passa.
    expect(
      caminhos(
        await extractArchive(gzipSync(tar), 'pacote.tar.gz', { maxUncompressedBytes: 8 * 1024 * 1024 }),
      ),
    ).toEqual(['SKILL.md', 'peso.bin']);
  });

  it('o .zip dentro de envelope também recusa citando o teto, não o que sobrou', async () => {
    // O caminho do `.zip` não passa pelo leitor daqui: quem monta a mensagem é
    // o `readZipEntries`, do `zip.ts`, que aceita um número só e o usa tanto
    // para cortar quanto para escrever a recusa. Recebendo o restante do
    // orçamento, ele recusava citando o restante. Medido, com o teto em 1 MiB:
    // "passa do limite de 0 MB" — número que não está em
    // `ZIP_MAX_UNCOMPRESSED_BYTES` nem em lugar nenhum.
    const zip = makeZip({ 'SKILL.md': '# ok', 'peso.bin': ruido(768 * 1024) });
    const teto = 1024 * 1024;

    // Cru, o mesmo `.zip` cabe: são 768 KiB de um teto de 1 MiB.
    expect(caminhos(await extractArchive(zip, 'pacote.zip', { maxUncompressedBytes: teto }))).toEqual(
      ['SKILL.md', 'peso.bin'],
    );

    // Dentro do envelope, não: o `.gz` já gastou 768 KiB do orçamento ao
    // produzir o `.zip`, e as entradas pedem outros 768 KiB. Essa parte é o
    // orçamento cumulativo funcionando, e não pode regredir.
    await expect(
      extractArchive(gzipSync(zip), 'pacote.zip.gz', { maxUncompressedBytes: teto }),
    ).rejects.toThrow(ZipLimitError);
    await expect(
      extractArchive(gzipSync(zip), 'pacote.zip.gz', { maxUncompressedBytes: teto }),
    ).rejects.toThrow('limite de 1 MB');

    // Com orçamento para as duas etapas, o mesmo `.zip.gz` passa.
    expect(
      caminhos(
        await extractArchive(gzipSync(zip), 'pacote.zip.gz', {
          maxUncompressedBytes: 2 * 1024 * 1024,
        }),
      ),
    ).toEqual(['SKILL.md', 'peso.bin']);
  });

  it('a recusa por entradas demais no .zip continua citando o limite de entradas', async () => {
    // A troca de mensagem do teste acima vale **só** para a recusa por bytes. A
    // de entradas demais também é `ZipLimitError`, mas já cita o número que o
    // operador configurou, porque `maxEntries` vai inteiro para o leitor:
    // reescrevê-la trocaria uma mensagem certa por outra, sobre bytes, que não
    // tem nada a ver com o que aconteceu.
    const zip = makeZip(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.md`, 'x'])));

    await expect(
      extractArchive(gzipSync(zip), 'pacote.zip.gz', { maxEntries: 5 }),
    ).rejects.toThrow(ZipLimitError);
    await expect(
      extractArchive(gzipSync(zip), 'pacote.zip.gz', { maxEntries: 5 }),
    ).rejects.toThrow('entradas demais (20); o limite é 5');
  });

  it('aceita dois envelopes encadeados e recusa o terceiro', async () => {
    const tar = await makeTar([{ name: 'SKILL.md', content: '# ok' }]);

    // `.tar.gz` recomprimido ao baixar ainda é um pacote legítimo.
    expect(caminhos(await extractArchive(gzipSync(gzipSync(tar)), 'skills.tar.gz.gz'))).toEqual([
      'SKILL.md',
    ]);

    // Três camadas não são embalagem, são bomba: cada uma multiplica a saída da
    // anterior, e nenhum empacotador honesto produz isso.
    await expect(
      extractArchive(gzipSync(gzipSync(gzipSync(tar))), 'bomba.tar.gz.gz.gz'),
    ).rejects.toThrow(ZipLimitError);
    await expect(
      extractArchive(zstdCompressSync(gzipSync(zstdCompressSync(tar))), 'bomba.tar.zst'),
    ).rejects.toThrow(ZipLimitError);
  });

  it('recusa a bomba de descompressão antes de materializá-la', async () => {
    // 4 MB de zeros viram alguns KB: é o formato de uma bomba. O `maxOutputLength`
    // do zlib é o que impede a alocação — conferir o tamanho depois seria
    // conferir com o processo já sem memória.
    const bomba = Buffer.alloc(4 * 1024 * 1024);

    await expect(
      extractArchive(gzipSync(bomba), 'bomba.gz', { maxUncompressedBytes: 64 * 1024 }),
    ).rejects.toThrow(ZipLimitError);
    await expect(
      extractArchive(zstdCompressSync(bomba), 'bomba.zst', { maxUncompressedBytes: 64 * 1024 }),
    ).rejects.toThrow(ZipLimitError);
  });

  it('recusa um envelope corrompido como formato, não como limite', async () => {
    const gz = gzipSync(Buffer.from('# Skill'));
    gz[10] ^= 0xff; // estraga o miolo, preservando a assinatura

    await expect(extractArchive(gz, 'SKILL.md.gz')).rejects.toThrow(ZipFormatError);
  });
});

describe('extractArchive — formatos recusados de propósito', () => {
  // Decisão do mantenedor: abrir RAR exigiria o `node-unrar-js`, cuja cláusula
  // do UnRAR não combina com a licença MIT do projeto. A recusa tem mensagem
  // própria porque "arquivo corrompido" mandaria o usuário procurar o defeito
  // num pacote que está perfeito.
  const casos: readonly [string, number[]][] = [
    ['RAR', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
    ['bzip2', ASSINATURA_BZIP2],
  ];

  for (const [nome, assinatura] of casos) {
    it(`recusa ${nome} dizendo quais formatos entram`, async () => {
      const arquivo = comAssinatura(assinatura);

      await expect(extractArchive(arquivo, `pacote.${nome}`)).rejects.toThrow(ArchiveUnsupportedError);
      // `api.ts` mapeia `ZipError` para 400: é assim que a mensagem chega à tela.
      await expect(extractArchive(arquivo, `pacote.${nome}`)).rejects.toThrow(ZipError);
      await expect(extractArchive(arquivo, `pacote.${nome}`)).rejects.toThrow(nome);
      await expect(extractArchive(arquivo, `pacote.${nome}`)).rejects.toThrow(/\.zip, \.skill, \.tar/);
      // O `.zstd` é aceito, então aparece na lista: mandar reempacotar num
      // formato que o servidor abre só ajuda se a lista disser todos eles.
      await expect(extractArchive(arquivo, `pacote.${nome}`)).rejects.toThrow('.zstd');
    });
  }

  it('recusa como ilegível o que não é pacote nenhum', async () => {
    const texto = Buffer.from('isto não é um pacote, é um .txt renomeado', 'utf8');

    await expect(extractArchive(texto, 'skills.zip')).rejects.toThrow(ZipFormatError);
    await expect(extractArchive(texto, 'skills.zip')).rejects.toThrow(ZipError);
  });
});

describe('extractZip depois do refactor', () => {
  // A bateria inteira está em `zip.test.ts`; estes fixam aqui o que o
  // `readZipEntries` extraído não podia mudar — o desembrulho da pasta raiz, os
  // tetos e o erro tipado do arquivo ilegível.
  it('mantém o desembrulho da pasta raiz e os limites', () => {
    const files = extractZip(makeZip({ 'minha-skill/SKILL.md': '# a', 'minha-skill/ref/b.md': '# b' }));
    expect(files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'ref/b.md']);

    const bomba = makeZip({ 'SKILL.md': '# ok', 'bomba.bin': Buffer.alloc(4 * 1024 * 1024) });
    expect(() => extractZip(bomba, { maxUncompressedBytes: 1024 * 1024 })).toThrow(ZipLimitError);
    expect(() => extractZip(Buffer.from('não sou zip'))).toThrow(ZipFormatError);
  });

  it('passa a descartar o AppleDouble solto — a única mudança de comportamento', () => {
    // O filtro novo mora no `readZipEntries`, então vale para o `.zip` de uma
    // skill também. É correção: `._SKILL.md` com a assinatura é metadado do
    // macOS, nunca conteúdo, e antes virava um anexo binário na skill.
    const files = extractZip(makeZip({ 'SKILL.md': '# ok', '._SKILL.md': appleDouble() }));
    expect(files.map((f) => f.relativePath)).toEqual(['SKILL.md']);

    // E o arquivo legítimo de nome parecido continua entrando.
    const comConfig = extractZip(makeZip({ 'SKILL.md': '# ok', '._config': 'porta=8080' }));
    expect(comConfig.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', '._config'].sort());
  });
});
