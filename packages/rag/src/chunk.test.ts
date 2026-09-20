/**
 * A divisão, o texto de metadados e o hash (§4 e §4.1 de `docs/14-rag.md`).
 *
 * O ponto que os testes protegem é o determinismo: a mesma skill tem que dar
 * os mesmos textos, na mesma ordem, com os mesmos hashes. É o que faz uma
 * reindexação sem mudança de conteúdo não gastar embedding nenhum — e o que
 * faz duas skills com o mesmo arquivo compartilharem o vetor.
 */
import { describe, expect, it } from 'vitest';
import { chunkSkill, metaText, splitText, DEFAULT_MAX_FILE_BYTES } from './chunk.js';
import { textSha256, textSha256Hex } from './hash.js';
import { MODELO_FALSO } from './fake.js';
import { GEMINI_EMBEDDING_2 } from './google.js';

const arquivo = (relativePath: string, textContent: string | null, id = `id-${relativePath}`) => ({
  id,
  relativePath,
  textContent,
});

describe('o texto de metadados', () => {
  it('é nome, descrição e tags em ordem alfabética, uma por linha', () => {
    expect(
      metaText({ name: 'Conventional Commits', description: 'Padroniza commits', tags: ['git', 'boas-praticas'] }),
    ).toBe('Conventional Commits\nPadroniza commits\nboas-praticas, git');
  });

  it('a ordem de inserção das tags não muda o texto — nem o hash', () => {
    const a = metaText({ name: 'X', description: 'd', tags: ['zulu', 'alfa', 'mike'] });
    const b = metaText({ name: 'X', description: 'd', tags: ['mike', 'zulu', 'alfa'] });
    expect(a).toBe(b);
    expect(textSha256Hex(a)).toBe(textSha256Hex(b));
  });

  it('sem tag não sobra linha de tags; sem descrição não sobra linha em branco', () => {
    expect(metaText({ name: 'X', description: 'd', tags: [] })).toBe('X\nd');
    expect(metaText({ name: 'X', description: null, tags: ['git'] })).toBe('X\ngit');
    expect(metaText({ name: 'X', description: '   ', tags: [] })).toBe('X');
  });
});

describe('a divisão em partes', () => {
  it('texto curto vai inteiro, numa parte só', () => {
    expect(splitText('uma linha', 1000)).toEqual(['uma linha']);
  });

  it('texto vazio ou só com espaços não gera parte', () => {
    expect(splitText('', 1000)).toEqual([]);
    expect(splitText('   \n\n  ', 1000)).toEqual([]);
  });

  it('corta primeiro nos títulos Markdown', () => {
    const texto = ['# Um', 'a'.repeat(60), '# Dois', 'b'.repeat(60)].join('\n');
    const partes = splitText(texto, 80);
    expect(partes).toHaveLength(2);
    expect(partes[0]).toMatch(/^# Um/);
    expect(partes[1]).toMatch(/^# Dois/);
  });

  it('sem título, cai nas linhas em branco', () => {
    const texto = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    const partes = splitText(texto, 80);
    expect(partes).toHaveLength(2);
    expect(partes[0]).toBe('a'.repeat(60));
  });

  it('sem estrutura nenhuma, corta no teto — e nenhuma parte passa dele', () => {
    const partes = splitText('x'.repeat(500), 100);
    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(100);
    expect(partes.join('')).toBe('x'.repeat(500));
  });

  it('junta blocos pequenos enquanto couberem, em vez de gerar partes minúsculas', () => {
    const texto = ['# A', 'curto', '# B', 'curto', '# C', 'curto'].join('\n');
    expect(splitText(texto, 1000)).toEqual([texto]);
  });

  it('é determinístico: a mesma entrada dá a mesma saída', () => {
    const texto = ['# Um', 'a'.repeat(300), '', '# Dois', 'b'.repeat(300)].join('\n');
    expect(splitText(texto, 120)).toEqual(splitText(texto, 120));
  });

  it('o teto do modelo cabe no limite de tokens com o prefixo junto', () => {
    // 6.000 caracteres + prefixo de até 200 fica abaixo dos 8.192 tokens.
    expect(GEMINI_EMBEDDING_2.maxPartChars).toBe(6000);
    expect(GEMINI_EMBEDDING_2.documentPrefix.length).toBeLessThanOrEqual(200);
    expect(GEMINI_EMBEDDING_2.queryPrefix.length).toBeLessThanOrEqual(200);
  });
});

describe('a skill inteira', () => {
  const skill = {
    name: 'Conventional Commits',
    description: 'Padroniza mensagens de commit',
    tags: ['git'],
    files: [
      arquivo('SKILL.md', '# Conventional Commits\n\nUse `feat:` e `fix:`.'),
      arquivo('exemplos/README.md', 'exemplos aqui'),
      arquivo('logo.png', null),
    ],
  };

  it('dá um texto de metadados e um por arquivo de texto, em ordem de caminho', () => {
    const { occurrences } = chunkSkill(skill, MODELO_FALSO);
    expect(occurrences.map((o) => [o.source, o.relativePath, o.part])).toEqual([
      ['meta', '', 0],
      ['file', 'SKILL.md', 0],
      ['file', 'exemplos/README.md', 0],
    ]);
  });

  it('o binário não vira texto e não aparece nos pulados', () => {
    const { occurrences, skipped } = chunkSkill(skill, MODELO_FALSO);
    expect(occurrences.some((o) => o.relativePath === 'logo.png')).toBe(false);
    expect(skipped.some((s) => s.relativePath === 'logo.png')).toBe(false);
  });

  it('imagem que por acaso é texto — o `.svg` — não vai ao provedor', () => {
    const { occurrences, skipped } = chunkSkill(
      {
        ...skill,
        files: [
          arquivo('SKILL.md', '# Conventional Commits'),
          arquivo('assets/logo.svg', '<svg><path d="M0 0 L9 9"/></svg>'),
          // O banco não deveria dar isto como texto; se der, também não sai.
          arquivo('firmware.bin', `MZ${String.fromCharCode(1)}`),
        ],
      },
      MODELO_FALSO,
    );

    expect(occurrences.map((o) => o.relativePath)).toEqual(['', 'SKILL.md']);
    expect(skipped).toEqual([
      { relativePath: 'assets/logo.svg', reason: 'nao-e-texto', mimeType: 'image/svg+xml' },
      { relativePath: 'firmware.bin', reason: 'nao-e-texto', mimeType: 'application/octet-stream' },
    ]);
  });

  it('o critério é o mime do `shared`, não uma lista nova: código e configuração entram', () => {
    const caminhos = [
      '.env.example',
      'LICENSE',
      'config.yaml',
      'dados.json',
      'lib/Cliente.php',
      'notas.md',
      'schema.sql',
    ];
    const { occurrences, skipped } = chunkSkill(
      { ...skill, files: caminhos.map((p) => arquivo(p, 'conteúdo')) },
      MODELO_FALSO,
    );

    expect(occurrences.filter((o) => o.source === 'file').map((o) => o.relativePath)).toEqual(
      caminhos,
    );
    expect(skipped).toEqual([]);
  });

  it('a ocorrência de meta não tem arquivo, e a de arquivo tem — como a 020 exige', () => {
    const { occurrences } = chunkSkill(skill, MODELO_FALSO);
    const meta = occurrences.find((o) => o.source === 'meta');
    expect(meta?.fileId).toBeNull();
    expect(meta?.relativePath).toBe('');

    for (const o of occurrences.filter((x) => x.source === 'file')) {
      expect(o.fileId).not.toBeNull();
      expect(o.relativePath).not.toBe('');
    }
  });

  it('arquivo vazio ou só com espaços não gera texto, e sai como pulado', () => {
    const { occurrences, skipped } = chunkSkill(
      { ...skill, files: [arquivo('vazio.md', '   \n  ')] },
      MODELO_FALSO,
    );
    expect(occurrences.map((o) => o.source)).toEqual(['meta']);
    expect(skipped).toEqual([{ relativePath: 'vazio.md', reason: 'vazio' }]);
  });

  it('arquivo acima do teto é pulado inteiro, com o motivo e o tamanho', () => {
    const grande = 'x'.repeat(DEFAULT_MAX_FILE_BYTES + 1);
    const { occurrences, skipped } = chunkSkill(
      { ...skill, files: [arquivo('grande.md', grande)] },
      MODELO_FALSO,
    );
    expect(occurrences.map((o) => o.source)).toEqual(['meta']);
    expect(skipped[0]).toMatchObject({ relativePath: 'grande.md', reason: 'grande-demais' });
    expect(skipped[0]?.bytes).toBe(DEFAULT_MAX_FILE_BYTES + 1);
  });

  it('arquivo longo vira partes numeradas a partir de 0, na ordem do arquivo', () => {
    const longo = ['# A', 'a'.repeat(200), '# B', 'b'.repeat(200), '# C', 'c'.repeat(200)].join('\n');
    const { occurrences } = chunkSkill({ ...skill, files: [arquivo('longo.md', longo)] }, MODELO_FALSO, {
      maxPartChars: 220,
    });
    const partes = occurrences.filter((o) => o.source === 'file');
    expect(partes.map((p) => p.part)).toEqual([0, 1, 2]);
    expect(partes[0]?.content).toMatch(/^# A/);
    expect(partes[2]?.content).toMatch(/^# C/);
  });

  it('nenhum texto canônico leva prefixo do driver', () => {
    const { occurrences } = chunkSkill(skill, MODELO_FALSO);
    for (const o of occurrences) {
      expect(o.content.startsWith(MODELO_FALSO.documentPrefix)).toBe(false);
      expect(o.content.startsWith(GEMINI_EMBEDDING_2.documentPrefix)).toBe(false);
    }
  });

  it('duas skills com o mesmo arquivo dão o mesmo hash — é o que compartilha o vetor', () => {
    const conteudo = '# Igual\n\nmesmo conteúdo';
    const a = chunkSkill({ ...skill, name: 'A', files: [arquivo('SKILL.md', conteudo, 'f1')] }, MODELO_FALSO);
    const b = chunkSkill({ ...skill, name: 'B', files: [arquivo('SKILL.md', conteudo, 'f2')] }, MODELO_FALSO);

    const hashA = textSha256Hex(a.occurrences.find((o) => o.source === 'file')!.content);
    const hashB = textSha256Hex(b.occurrences.find((o) => o.source === 'file')!.content);
    expect(hashA).toBe(hashB);

    // Os metadados diferem, porque o nome entra neles.
    const metaA = textSha256Hex(a.occurrences[0]!.content);
    const metaB = textSha256Hex(b.occurrences[0]!.content);
    expect(metaA).not.toBe(metaB);
  });

  it('a divisão inteira é determinística', () => {
    expect(chunkSkill(skill, MODELO_FALSO)).toEqual(chunkSkill(skill, MODELO_FALSO));
  });
});

describe('o hash', () => {
  it('é o SHA-256 dos bytes UTF-8, em 32 bytes', () => {
    const h = textSha256('abc');
    expect(h).toHaveLength(32);
    expect(h.toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('acento e emoji contam como os bytes UTF-8 que são', () => {
    // Se houvesse normalização, estes dois bateriam — e não batem.
    expect(textSha256Hex('ação')).not.toBe(textSha256Hex('acao'));
    expect(textSha256Hex('🔮')).toBe(
      textSha256(Buffer.from('🔮', 'utf8').toString('utf8')).toString('hex'),
    );
  });

  it('não normaliza nada: espaço no fim muda o hash', () => {
    expect(textSha256Hex('x')).not.toBe(textSha256Hex('x '));
  });
});
