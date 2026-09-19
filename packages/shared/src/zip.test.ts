import { randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  ZipError,
  ZipFormatError,
  ZipLimitError,
  extractZip,
  toExtractedFile,
  zipToBuffer,
} from './zip.js';

function makeZip(entries: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

/**
 * Monta um ZIP de uma entrada à mão, com o tamanho descomprimido do diretório
 * central escolhido por quem chama. Nenhuma biblioteca gera um ZIP que minta no
 * tamanho — e é exatamente isso que precisa ser testado.
 */
function zipDeclarando(name: string, payload: Buffer, tamanhoDeclarado: number): Buffer {
  const nome = Buffer.from(name, 'utf8');
  const comprimido = deflateRawSync(payload, { level: 9 });
  const crc = crc32(payload) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // assinatura do cabeçalho local
  local.writeUInt16LE(20, 4); // versão necessária
  local.writeUInt16LE(8, 8); // método: DEFLATE
  local.writeUInt16LE(0x21, 12); // data
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comprimido.length, 18);
  local.writeUInt32LE(tamanhoDeclarado, 22);
  local.writeUInt16LE(nome.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // assinatura do diretório central
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comprimido.length, 20);
  central.writeUInt32LE(tamanhoDeclarado, 24); // o número em que ninguém deve confiar
  central.writeUInt16LE(nome.length, 28);

  const parteLocal = Buffer.concat([local, nome, comprimido]);
  const parteCentral = Buffer.concat([central, nome]);

  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); // assinatura do fim do diretório central
  fim.writeUInt16LE(1, 8); // entradas neste disco
  fim.writeUInt16LE(1, 10); // entradas no total
  fim.writeUInt32LE(parteCentral.length, 12);
  fim.writeUInt32LE(parteLocal.length, 16);

  return Buffer.concat([parteLocal, parteCentral, fim]);
}

describe('zipToBuffer', () => {
  it('gera um zip legível preservando os caminhos', async () => {
    const buffer = await zipToBuffer([
      { relativePath: 'SKILL.md', content: '# Olá' },
      { relativePath: 'examples/foo.txt', content: Buffer.from('bar') },
    ]);

    const entries = new AdmZip(buffer).getEntries().map((e) => e.entryName).sort();
    expect(entries).toEqual(['SKILL.md', 'examples/foo.txt']);
    expect(new AdmZip(buffer).getEntry('SKILL.md')!.getData().toString('utf8')).toBe('# Olá');
  });

  it('gera um zip vazio sem falhar', async () => {
    const buffer = await zipToBuffer([]);
    expect(new AdmZip(buffer).getEntries()).toHaveLength(0);
  });
});

describe('extractZip', () => {
  it('extrai arquivos de texto e binários com o mime correto', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const files = extractZip(makeZip({ 'SKILL.md': '# Skill', 'img/logo.png': png }));

    const md = files.find((f) => f.relativePath === 'SKILL.md')!;
    expect(md.textContent).toBe('# Skill');
    expect(md.binaryContent).toBeNull();
    expect(md.mimeType).toBe('text/markdown');

    const logo = files.find((f) => f.relativePath === 'img/logo.png')!;
    expect(logo.textContent).toBeNull();
    expect(logo.binaryContent?.equals(png)).toBe(true);
    expect(logo.sizeBytes).toBe(png.byteLength);
  });

  it('remove a pasta raiz única', () => {
    const files = extractZip(makeZip({ 'minha-skill/SKILL.md': '# a', 'minha-skill/ref/b.md': '# b' }));
    expect(files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'ref/b.md']);
  });

  it('preserva a estrutura quando há mais de uma raiz', () => {
    const files = extractZip(makeZip({ 'SKILL.md': '# a', 'ref/b.md': '# b' }));
    expect(files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'ref/b.md']);
  });

  it('ignora lixo de sistema operacional', () => {
    const files = extractZip(makeZip({ 'SKILL.md': '# a', '__MACOSX/._SKILL.md': 'x', '.DS_Store': 'y' }));
    expect(files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
  });

  it('nunca produz um caminho que escape da raiz da skill', () => {
    const files = extractZip(
      makeZip({ '../escapou.md': 'x', '/abs.md': 'y', 'SKILL.md': '# ok' }),
      { stripSingleRootDir: false },
    );

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.relativePath.startsWith('/')).toBe(false);
      expect(file.relativePath.split('/')).not.toContain('..');
    }
    expect(files.map((f) => f.relativePath)).toContain('SKILL.md');
  });
});

describe('toExtractedFile', () => {
  it('trata conteúdo textual com bytes nulos como binário', () => {
    const file = toExtractedFile('notas.md', Buffer.from([0x61, 0x00, 0x62]));
    expect(file.textContent).toBeNull();
    expect(file.binaryContent).not.toBeNull();
  });
});

describe('extractZip — limites de descompressão', () => {
  it('recusa quando o conteúdo descomprimido passa do teto', () => {
    // 4 MB de zeros comprimem para poucos KB: é o formato de uma zip bomb.
    const bomb = makeZip({ 'SKILL.md': '# ok', 'bomba.bin': Buffer.alloc(4 * 1024 * 1024) });

    expect(() => extractZip(bomb, { maxUncompressedBytes: 1024 * 1024 })).toThrow(ZipLimitError);
  });

  it('recusa quando há entradas demais', () => {
    const entries: Record<string, string> = { 'SKILL.md': '# ok' };
    for (let i = 0; i < 20; i += 1) entries[`f${i}.md`] = 'x';

    expect(() => extractZip(makeZip(entries), { maxEntries: 5 })).toThrow(ZipLimitError);
  });

  it('deixa passar um .zip dentro dos limites', () => {
    const files = extractZip(makeZip({ 'SKILL.md': '# ok', 'nota.md': 'oi' }), {
      maxUncompressedBytes: 1024 * 1024,
      maxEntries: 10,
      stripSingleRootDir: false,
    });

    expect(files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'nota.md']);
  });

  it('não estoura o teto somando entradas individualmente pequenas', () => {
    const entries: Record<string, Buffer> = {};
    for (let i = 0; i < 10; i += 1) entries[`p${i}.bin`] = Buffer.alloc(200 * 1024);

    expect(() => extractZip(makeZip(entries), { maxUncompressedBytes: 1024 * 1024 })).toThrow(
      ZipLimitError,
    );
  });
});

describe('extractZip — arquivo ilegível', () => {
  it('recusa um arquivo que não é zip com erro tipado, não genérico', () => {
    const lixo = Buffer.from('isto não é um zip, é um .txt renomeado', 'utf8');

    expect(() => extractZip(lixo)).toThrow(ZipFormatError);
    // A borda HTTP trata `ZipError` como 400; um Error solto viraria 500.
    expect(() => extractZip(lixo)).toThrow(ZipError);
  });

  it('recusa um zip truncado', () => {
    const completo = makeZip({ 'SKILL.md': '# ok' });
    expect(() => extractZip(completo.subarray(0, completo.length - 12))).toThrow(ZipFormatError);
  });

  it('mantém ZipLimitError como subclasse de ZipError', () => {
    const bomba = makeZip({ 'grande.bin': Buffer.alloc(2 * 1024 * 1024) });
    expect(() => extractZip(bomba, { maxUncompressedBytes: 1024 })).toThrow(ZipLimitError);
    expect(() => extractZip(bomba, { maxUncompressedBytes: 1024 })).toThrow(ZipError);
  });
});

describe('extractZip — cabeçalho que declara menos do que entrega', () => {
  it('recusa a entrada de tamanho declarado zero antes de descomprimir', () => {
    // 64 KB aleatórios quase não comprimem: medidos depois, caberiam folgados no
    // teto de 1 MB, e o .zip seria aceito. Declarando zero, `adm-zip` inflaria
    // sem teto algum — é aí que a memória ia embora, independente do limite.
    // A recusa só protege se vier antes de `getData()`, e é isso que se fixa
    // aqui: com o conteúdo real dentro do limite, o .zip ainda é recusado.
    const zip = zipDeclarando('bomba.bin', randomBytes(64 * 1024), 0);

    expect(() => extractZip(zip, { maxUncompressedBytes: 1024 * 1024 })).toThrow(ZipLimitError);
  });

  it('aceita o arquivo vazio gravado como DEFLATE, que declara zero de verdade', () => {
    // O `zipfile` do Python grava arquivo vazio assim: 2 bytes comprimidos e
    // zero descomprimido. Recusar todo tamanho declarado zero quebraria esses
    // .zip legítimos — o que a cota de expansão do DEFLATE evita.
    const files = extractZip(zipDeclarando('vazio.txt', Buffer.alloc(0), 0));

    expect(files.map((f) => [f.relativePath, f.sizeBytes])).toEqual([['vazio.txt', 0]]);
  });
});
