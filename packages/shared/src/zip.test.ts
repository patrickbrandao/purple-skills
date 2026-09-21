import { randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  ZipContentError,
  ZipError,
  ZipFormatError,
  ZipLimitError,
  extractZip,
  readZipEntries,
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

function escreverU64(buf: Buffer, valor: number, pos: number): void {
  buf.writeUInt32LE(valor >>> 0, pos);
  buf.writeUInt32LE(Math.floor(valor / 0x100000000) >>> 0, pos + 4);
}

/**
 * Monta um ZIP à mão com o número de entradas do **fim do diretório central**
 * escolhido por quem chama, independente de quantos registros existem de
 * verdade, e opcionalmente nesse fim no formato ZIP64.
 *
 * É esse número que o leitor usa para dimensionar o trabalho antes de olhar
 * registro nenhum, e nenhuma biblioteca gera um ZIP que minta nele — nem que
 * declare mais do que os 65.535 que cabem nos 16 bits do fim clássico.
 *
 * Os registros são de 47 bytes (46 + um nome de um byte) e todos apontam para o
 * mesmo cabeçalho local: é o que torna barato, para quem envia, declarar um
 * diretório central enorme.
 */
function zipComContagemDeclarada(opcoes: {
  declaradas: number;
  registros?: number;
  zip64?: boolean;
}): Buffer {
  const { declaradas, registros = declaradas, zip64 = false } = opcoes;

  const payload = Buffer.from('x', 'utf8');
  const comprimido = deflateRawSync(payload, { level: 9 });
  const crc = crc32(payload) >>> 0;
  const nome = Buffer.from('a', 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // assinatura do cabeçalho local
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // método: DEFLATE
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comprimido.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nome.length, 26);
  const parteLocal = Buffer.concat([local, nome, comprimido]);

  const registro = Buffer.alloc(46);
  registro.writeUInt32LE(0x02014b50, 0); // assinatura do diretório central
  registro.writeUInt16LE(20, 4);
  registro.writeUInt16LE(20, 6);
  registro.writeUInt16LE(8, 10);
  registro.writeUInt16LE(0x21, 14);
  registro.writeUInt32LE(crc, 16);
  registro.writeUInt32LE(comprimido.length, 20);
  registro.writeUInt32LE(payload.length, 24);
  registro.writeUInt16LE(nome.length, 28);
  const umRegistro = Buffer.concat([registro, nome]);

  const central = Buffer.alloc(umRegistro.length * registros);
  for (let i = 0; i < registros; i += 1) umRegistro.copy(central, i * umRegistro.length);

  const partes = [parteLocal, central];
  const offsetCentral = parteLocal.length;

  if (zip64) {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0); // assinatura do fim ZIP64
    z64.writeUInt32LE(56 - 12, 4); // tamanho do registro, sem os 12 bytes iniciais
    z64.writeUInt32LE(0, 8);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeUInt32LE(0, 16);
    z64.writeUInt32LE(0, 20);
    escreverU64(z64, declaradas, 24); // entradas neste disco
    escreverU64(z64, declaradas, 32); // entradas no total
    escreverU64(z64, central.length, 40);
    escreverU64(z64, offsetCentral, 48);

    const localizador = Buffer.alloc(20);
    localizador.writeUInt32LE(0x07064b50, 0); // assinatura do localizador ZIP64
    localizador.writeUInt32LE(0, 4);
    escreverU64(localizador, offsetCentral + central.length, 8);
    localizador.writeUInt32LE(1, 16);

    partes.push(z64, localizador);
  }

  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); // assinatura do fim do diretório central
  // Com ZIP64, o fim clássico guarda as marcas de "veja no ZIP64".
  fim.writeUInt16LE(zip64 ? 0xffff : declaradas, 8); // entradas neste disco
  fim.writeUInt16LE(zip64 ? 0xffff : declaradas, 10); // entradas no total
  fim.writeUInt32LE(zip64 ? 0xffffffff : central.length, 12);
  fim.writeUInt32LE(zip64 ? 0xffffffff : offsetCentral, 16);
  partes.push(fim);

  return Buffer.concat(partes);
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

  it('não remove a pasta raiz quando ela não traz o SKILL.md: é subpasta, não embrulho', () => {
    // `zip -r scripts.zip scripts/` numa skill que já existe: cortar `scripts/`
    // gravaria os dois na raiz, ao lado dos originais.
    const files = extractZip(makeZip({ 'scripts/run.py': 'x', 'scripts/util.py': 'y' }));
    expect(files.map((f) => f.relativePath).sort()).toEqual(['scripts/run.py', 'scripts/util.py']);

    const unico = extractZip(makeZip({ 'docs/README.md': '# leia' }));
    expect(unico.map((f) => f.relativePath)).toEqual(['docs/README.md']);
  });

  it('remove a pasta raiz mesmo com o SKILL.md em caixa baixa', () => {
    const files = extractZip(makeZip({ 'minha-skill/skill.md': '# a', 'minha-skill/ref/b.md': '# b' }));
    expect(files.map((f) => f.relativePath).sort()).toEqual(['ref/b.md', 'skill.md']);
  });

  it('um SKILL.md mais fundo não faz da pasta raiz um embrulho', () => {
    const files = extractZip(
      makeZip({ 'references/exemplo/SKILL.md': '# exemplo', 'references/exemplo/a.md': '# a' }),
    );
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      'references/exemplo/SKILL.md',
      'references/exemplo/a.md',
    ]);
  });

  it('o lixo de sistema operacional não decide se há embrulho', () => {
    const files = extractZip(
      makeZip({ 'minha-skill/SKILL.md': '# a', 'minha-skill/ref/b.md': '# b', '__MACOSX/minha-skill/._SKILL.md': 'x' }),
    );
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

  it('guarda byte a byte, como binário, o texto que não é UTF-8 válido', () => {
    // `preço;ação\n` como o Excel exporta um .csv (Windows-1252): 11 bytes.
    // `toString('utf8')` devolveria `pre�o;a��o` sem erro, e regravado isso
    // são 17 bytes — o original não volta mais.
    const cp1252 = Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f, 0x3b, 0x61, 0xe7, 0xe3, 0x6f, 0x0a]);
    const file = toExtractedFile('dados.csv', cp1252);

    expect(file.textContent).toBeNull();
    expect(file.binaryContent?.equals(cp1252)).toBe(true);
    expect(file.mimeType).toBe('text/csv');
    expect(file.sizeBytes).toBe(11);
  });

  it('continua texto o UTF-8 válido: com acento, vazio e com BOM, que volta inteiro', () => {
    expect(toExtractedFile('dados.csv', Buffer.from('preço;ação\n', 'utf8')).textContent).toBe('preço;ação\n');

    const vazio = toExtractedFile('vazio.txt', Buffer.alloc(0));
    expect(vazio.textContent).toBe('');
    expect(vazio.binaryContent).toBeNull();

    const comBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a;b\n', 'utf8')]);
    const file = toExtractedFile('dados.csv', comBom);
    expect(file.binaryContent).toBeNull();
    expect(Buffer.from(file.textContent ?? '', 'utf8').equals(comBom)).toBe(true);
  });
});

describe('extractZip — texto que não é UTF-8', () => {
  // `# Ação` em Windows-1252.
  const cp1252 = Buffer.from([0x23, 0x20, 0x41, 0xe7, 0xe3, 0x6f]);

  it('entrega o anexo com os bytes que vieram no .zip', () => {
    const files = extractZip(makeZip({ 'SKILL.md': '# ok', 'dados/planilha.csv': cp1252 }));
    const planilha = files.find((f) => f.relativePath === 'dados/planilha.csv')!;

    expect(planilha.textContent).toBeNull();
    expect(planilha.binaryContent?.equals(cp1252)).toBe(true);
  });

  it('recusa o SKILL.md que não é texto, em vez de entregá-lo sem conteúdo', () => {
    // Quem chama lê `textContent ?? ''`: com o principal binário, o upload numa
    // skill existente gravaria um corpo vazio por cima do prompt.
    expect(() => extractZip(makeZip({ 'SKILL.md': cp1252, 'a.md': 'x' }))).toThrow(ZipContentError);
    expect(() => extractZip(makeZip({ 'SKILL.md': Buffer.from([0x61, 0x00, 0x62]) }))).toThrow(ZipContentError);
    // Vale para o principal depois do desembrulho e em qualquer caixa.
    expect(() => extractZip(makeZip({ 'pacote/skill.md': cp1252, 'pacote/a.md': 'x' }))).toThrow(ZipContentError);
    // A borda HTTP e o mcp-admin tratam `ZipError`: 400 e `fail`, nunca 500.
    expect(() => extractZip(makeZip({ 'SKILL.md': cp1252 }))).toThrow(ZipError);
    expect(() => extractZip(makeZip({ 'SKILL.md': cp1252 }))).toThrow(/UTF-8/);
  });

  /*
   * A saída da regra acima, e só ela: a quarentena (`docs/15-quarentena.md`)
   * guarda bytes crus que ninguém decodifica, e recusar o pacote ali seria
   * recusar justamente o que o espaço existe para consertar — o SKILL.md que
   * saiu de um editor Windows. Quem cobra a codificação lá é a aprovação.
   */
  it('com `allowBinarySkillMd`, o principal binário entra como anexo, byte a byte', () => {
    const files = extractZip(makeZip({ 'SKILL.md': cp1252, 'a.md': 'x' }), { allowBinarySkillMd: true });
    const principal = files.find((file) => file.relativePath === 'SKILL.md');

    expect(principal?.textContent).toBeNull();
    expect(principal?.binaryContent?.equals(cp1252)).toBe(true);
    // O resto do pacote não muda: o desembrulho e os anexos seguem iguais.
    expect(files.map((file) => file.relativePath).sort()).toEqual(['SKILL.md', 'a.md']);
  });

  it('a opção não afrouxa nada além disso: o teto e o ZIP ilegível continuam recusando', () => {
    expect(() => extractZip(makeZip({ 'SKILL.md': '# ok' }), { allowBinarySkillMd: true, maxEntries: 0 })).toThrow(ZipError);
    expect(() => extractZip(Buffer.from('nao sou zip'), { allowBinarySkillMd: true })).toThrow(ZipError);
  });

  it('não confunde com o principal um SKILL.md de subpasta', () => {
    const files = extractZip(makeZip({ 'SKILL.md': '# ok', 'exemplos/SKILL.md': cp1252 }));
    const exemplo = files.find((f) => f.relativePath === 'exemplos/SKILL.md')!;

    expect(exemplo.textContent).toBeNull();
    expect(exemplo.binaryContent?.equals(cp1252)).toBe(true);
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

describe('readZipEntries — o teto de entradas antes de materializar', () => {
  it('recusa pelo número declarado, sem percorrer o diretório central', () => {
    // O fim do diretório central declara 20.001 entradas; de verdade há uma só.
    // Quem confere o teto depois de `getEntries()` nem chega a comparar: o
    // `adm-zip` dimensiona a lista pelo número declarado e morre antes disso —
    // daí um `ZipFormatError`, quando o que este .zip merece é a recusa por
    // limite. O erro que sai é a prova barata de que a ordem está certa.
    const zip = zipComContagemDeclarada({ declaradas: 20_001, registros: 1 });

    expect(() => readZipEntries(zip, { maxEntries: 20_000 })).toThrow(ZipLimitError);
    expect(() => readZipEntries(zip, { maxEntries: 20_000 })).toThrow(/20001/);
  });

  it('recusa um ZIP64 que declara 200.000 entradas sem gastar memória por entrada', () => {
    // 9 MB de registros de 47 bytes com o fim do diretório central em ZIP64: a
    // contagem de 16 bits do fim clássico para nos 65.535, o `adm-zip` lê o
    // ZIP64 e não para — é assim que um upload dentro dos 64 MB de
    // `ADMIN_MAX_UPLOAD_BYTES` declara mais de um milhão de entradas.
    const zip = zipComContagemDeclarada({ declaradas: 200_000, zip64: true });

    const rssAntes = process.resourceUsage().maxRSS;
    const inicio = process.hrtime.bigint();
    expect(() => readZipEntries(zip, { maxEntries: 20_000 })).toThrow(ZipLimitError);
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    const crescimentoKB = process.resourceUsage().maxRSS - rssAntes;

    // Medido com a conferência depois de `getEntries()`: +1,8 GB e 1,6 s, para
    // um .zip de 9 MB. Com a conferência antes: nenhum crescimento de RSS e
    // menos de um décimo de milissegundo. Os tetos são folgados — o que se afirma
    // é a ausência de custo proporcional às 200.000 entradas declaradas, não um
    // número exato de máquina nenhuma.
    expect(crescimentoKB).toBeLessThan(128 * 1024);
    expect(ms).toBeLessThan(250);
  });

  it('o número declarado só recusa: nunca é a medida do que veio', () => {
    // Três registros no diretório central, um declarado. O que volta é o que o
    // leitor materializou — por isso a contagem depois de `getEntries()` fica.
    const zip = zipComContagemDeclarada({ declaradas: 1, registros: 3 });

    expect(readZipEntries(zip, { maxEntries: 20_000 })).toHaveLength(1);
  });

  it('o .zip vazio válido continua passando: zero declarado não é entrada demais', async () => {
    const vazio = await zipToBuffer([]);

    expect(readZipEntries(vazio, { maxEntries: 0 })).toEqual([]);
  });
});
