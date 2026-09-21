import { describe, expect, it } from 'vitest';
import {
  buildFrontmatter,
  composeSkillMd,
  frontmatterObject,
  parseFrontmatter,
  skillMetaFromMarkdown,
  stripFrontmatter,
  type SkillMeta,
} from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('extrai pares chave: valor e devolve o corpo', () => {
    const { data, body } = parseFrontmatter('---\nname: Minha Skill\ndescription: Faz X\n---\n# Título\n');
    expect(data).toEqual({ name: 'Minha Skill', description: 'Faz X' });
    expect(body).toBe('# Título\n');
  });

  it('remove aspas dos valores', () => {
    const { data } = parseFrontmatter('---\nname: "Com: dois pontos"\n---\ncorpo');
    expect(data.name).toBe('Com: dois pontos');
  });

  it('lê as chaves indentadas do bloco metadata', () => {
    const { data } = parseFrontmatter(
      '---\nname: minha-skill\nmetadata:\n  title: Minha Skill\n  tags: git, ci\n---\ncorpo',
    );
    expect(data.title).toBe('Minha Skill');
    expect(data.tags).toBe('git, ci');
  });

  it('devolve o texto inteiro quando não há frontmatter', () => {
    const source = '# Sem frontmatter\n';
    expect(parseFrontmatter(source)).toEqual({ data: {}, body: source });
  });

  it('lê arquivo com quebra de linha do Windows (CRLF)', () => {
    const { data, body } = parseFrontmatter(
      '---\r\nname: minha-skill\r\ndescription: Faz X\r\nmetadata:\r\n  title: Minha Skill\r\n---\r\n# Corpo\r\n',
    );
    expect(data).toMatchObject({ name: 'minha-skill', description: 'Faz X', title: 'Minha Skill' });
    expect(body).toBe('# Corpo\r\n');
  });

  it('aceita o bloco que termina junto com o texto, sem quebra final', () => {
    expect(parseFrontmatter('---\nname: x\n---')).toEqual({ data: { name: 'x' }, body: '' });
  });

  it('a régua `---` no meio do corpo não é confundida com frontmatter', () => {
    const source = '# Título\n\n---\n\nname: isto é corpo\n\n---\n\nFim\n';
    expect(parseFrontmatter(source)).toEqual({ data: {}, body: source });
  });

  // O valor pode vir NAS LINHAS DE BAIXO. O parser lia só o resto da linha da
  // chave: `description: >-` virava a descrição literal ">-" e o texto sumia.
  it('lê escalar de bloco dobrado (`>`): as linhas viram uma só', () => {
    const { data, body } = parseFrontmatter(
      '---\nname: pdf-tools\ndescription: >-\n  Use quando o usuário quiser extrair, juntar\n  ou dividir PDFs.\nlicense: MIT\n---\n# Corpo\n',
    );
    expect(data.description).toBe('Use quando o usuário quiser extrair, juntar ou dividir PDFs.');
    // A chave depois do bloco continua sendo lida, e o corpo não muda.
    expect(data.license).toBe('MIT');
    expect(body).toBe('# Corpo\n');
  });

  it('no dobrado, linha em branco separa parágrafos', () => {
    const { data } = parseFrontmatter('---\ndescription: >\n  Primeiro\n  parágrafo.\n\n  Segundo.\n---\n');
    expect(data.description).toBe('Primeiro parágrafo.\nSegundo.');
  });

  it('lê escalar de bloco literal (`|`): as quebras e a indentação interna ficam', () => {
    const { data } = parseFrontmatter('---\ndescription: |\n  Linha um\n    recuada\n  Linha três\nname: x\n---\n');
    expect(data.description).toBe('Linha um\n  recuada\nLinha três');
    expect(data.name).toBe('x');
  });

  it.each(['>', '>-', '>+', '|', '|-', '|+', '>2', '|2-', '>-2', '>- # comentário'])(
    'reconhece o indicador de bloco `%s`, que nunca vira valor',
    (indicador) => {
      const { data } = parseFrontmatter(`---\ndescription: ${indicador}\n  Texto da descrição.\n---\n`);
      expect(data.description).toBe('Texto da descrição.');
    },
  );

  it('dentro do bloco, linha em forma de `chave: valor` é texto, não chave', () => {
    const { data } = parseFrontmatter('---\ndescription: |\n  Use para PDFs.\n  Triggers: pdf, merge\nname: x\n---\n');
    expect(data.description).toBe('Use para PDFs.\nTriggers: pdf, merge');
    expect(data).not.toHaveProperty('Triggers');
  });

  it('lê escalar de bloco dentro do `metadata:` indentado', () => {
    const { data } = parseFrontmatter(
      '---\nname: x\nmetadata:\n  title: >-\n    Um título\n    comprido\n  tags: git, ci\n---\n',
    );
    expect(data.title).toBe('Um título comprido');
    expect(data.tags).toBe('git, ci');
  });

  it('indicador de bloco sem linha nenhuma embaixo é valor vazio', () => {
    expect(parseFrontmatter('---\ndescription: >-\nname: x\n---\n').data).toEqual({ description: '', name: 'x' });
  });

  it('junta o escalar simples que continua na linha de baixo, como o PyYAML escreve', () => {
    // `yaml.safe_dump` quebra texto longo em 80 colunas assim; a continuação era
    // descartada e a descrição ficava cortada no meio da frase.
    const { data } = parseFrontmatter(
      '---\nname: pdf-tools\ndescription: Use quando o usuário quiser extrair, juntar ou dividir PDFs, preencher\n  formulários, e também quando pedir OCR de documento escaneado.\nlicense: MIT\n---\n',
    );
    expect(data.description).toBe(
      'Use quando o usuário quiser extrair, juntar ou dividir PDFs, preencher formulários, e também quando pedir OCR de documento escaneado.',
    );
    expect(data.license).toBe('MIT');
  });

  it('a continuação que começa com um link não vira a chave `https`', () => {
    // Em YAML o par pede espaço (ou fim de linha) depois dos dois-pontos.
    const { data } = parseFrontmatter('---\ndescription: A documentação completa está em\n  https://example.com/docs\n---\n');
    expect(data).toEqual({ description: 'A documentação completa está em https://example.com/docs' });
  });

  it('junta o escalar entre aspas que fecha na linha de baixo, e o valor que começa embaixo da chave', () => {
    expect(parseFrontmatter('---\ndescription: "Faz X: e\n  também Y"\n---\n').data.description).toBe('Faz X: e também Y');
    expect(parseFrontmatter('---\ndescription:\n  Faz X\n  e Y.\nname: x\n---\n').data).toEqual({
      description: 'Faz X e Y.',
      name: 'x',
    });
  });

  /*
   * **Era**, até a quarentena: a lista de bloco era descartada e `tags:` ficava
   * com o valor vazio. O pacote que a especificação Agent Skills escreve com
   * mais frequência perdia as tags inteiras, sem aviso — e a promoção de um
   * envio promete, na caixa de confirmação, que as tags saem do SKILL.md.
   */
  it('lê a lista de bloco nas duas indentações que o YAML aceita', () => {
    expect(parseFrontmatter('---\ntags:\n  - a\n  - b\ndescription: y\n---\n').data).toEqual({
      tags: 'a, b',
      description: 'y',
    });
    // Item na coluna da própria chave é a outra grafia válida.
    expect(parseFrontmatter('---\ntags:\n- a\n- b\n---\n').data).toEqual({ tags: 'a, b' });
    // As aspas saem item a item, como saem do escalar.
    expect(parseFrontmatter('---\ntags:\n  - "a"\n  - \'b\'\n---\n').data).toEqual({ tags: 'a, b' });
  });

  it('comentário não entra no valor, e o item solto depois de um valor continua ignorado', () => {
    expect(parseFrontmatter('---\ntags:\n  - a\n  # nota\n  - b\n---\n').data).toEqual({ tags: 'a, b' });
    // `chave: x` seguida de `- y` é YAML inválido: juntar os dois inventaria
    // um valor que ninguém escreveu, então o item segue descartado.
    expect(parseFrontmatter('---\ntags: a\n- lixo\n---\n').data).toEqual({ tags: 'a' });
  });

  /*
   * O `-` dentro de um escalar de bloco é texto, não item: o escalar consome as
   * linhas dele antes de o laço as ver, e é isso que este caso guarda.
   */
  it('hífen dentro de escalar de bloco continua sendo texto', () => {
    const { data } = parseFrontmatter('---\ndescription: |\n  - não é lista\n  - nem isto\ntags:\n  - a\n---\n');
    expect(data.description).toBe('- não é lista\n- nem isto');
    expect(data.tags).toBe('a');
  });
});

describe('stripFrontmatter', () => {
  it('remove o bloco de metadados e o espaço em branco à frente', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\n# Corpo\n')).toBe('# Corpo\n');
  });

  it('não mexe em texto sem frontmatter', () => {
    expect(stripFrontmatter('# Corpo\n\nParágrafo.')).toBe('# Corpo\n\nParágrafo.');
  });

  // O que já funcionava antes de a régua horizontal deixar de ser confundida
  // com frontmatter — fixado aqui para provar que não regrediu.
  it.each([
    ['CRLF', '---\r\nname: x\r\ndescription: y\r\n---\r\n# Corpo\r\n', '# Corpo\r\n'],
    ['espaço depois do `---` de fechamento', '---\nname: x\n---   \r\nCorpo\r\n', 'Corpo\r\n'],
    ['bloco que termina junto com o texto', '---\nname: x\n---', ''],
    ['bloco `metadata:` indentado', '---\nname: x\nmetadata:\n  title: T\n  tags: a, b\n---\ncorpo', 'corpo'],
    ['lista em bloco', '---\nname: x\nmetadata:\n  tags:\n    - a\n    - b\n---\ncorpo', 'corpo'],
    ['lista sem indentação, que o YAML aceita', '---\nname: x\ntags:\n- a\n- b\n---\ncorpo', 'corpo'],
    ['comentário YAML', '---\n# gerado pelo painel\nname: x\n---\ncorpo', 'corpo'],
    ['linha em branco dentro do bloco', '---\nname: x\n\ndescription: y\n---\ncorpo', 'corpo'],
    ['frontmatter inteiro indentado', '---\n  name: x\n  description: y\n---\ncorpo', 'corpo'],
    ['réguas no meio do corpo, depois do frontmatter', '---\nname: x\n---\n# T\n\nA\n\n---\n\nB\n', '# T\n\nA\n\n---\n\nB\n'],
    ['réguas no meio do corpo, sem frontmatter', '# T\n\n---\n\nA\n\n---\n\nB\n', '# T\n\n---\n\nA\n\n---\n\nB\n'],
    ['texto vazio', '', ''],
    ['só espaço em branco', ' \n\n', ''],
  ])('segue valendo: %s', (_caso, fonte, esperado) => {
    expect(stripFrontmatter(fonte)).toBe(esperado);
  });

  it('é idempotente — o segundo bloco `---` do corpo fica', () => {
    // O fixture antigo (`'---\nname: x\n---\n# Corpo\n'`) não exercitava o
    // título: o resultado não começava com `---`, então o segundo passe nunca
    // chegava a casar. Este começa, e o bloco que sobra é régua + prosa.
    const uma = stripFrontmatter('---\nname: x\n---\n---\nA\n---\nB\n');
    expect(uma).toBe('---\nA\n---\nB\n');
    expect(stripFrontmatter(uma)).toBe(uma);
  });

  // Bloco `---`…`---` sem cara de mapa YAML é régua horizontal do corpo, não
  // frontmatter: tudo que estava entre as duas réguas era apagado, em cada
  // leitura e em cada gravação, sem aviso.
  it.each([
    ['título e prosa entre duas réguas', '---\n\n# Título\n\nTexto\n\n---\n\nRodapé\n'],
    ['prosa com uma linha em forma de rótulo', '---\nIntrodução do prompt.\nNota: leia tudo antes.\n---\nResto\n'],
    ['rótulo com acento, que não é chave de YAML', '---\nAtenção: leia tudo antes.\n---\nResto\n'],
    ['um link sozinho entre as réguas', '---\nhttps://example.com/docs\n---\nResto\n'],
    ['lista de Markdown entre as réguas', '---\n- passo um\n- passo dois\n---\nResto\n'],
    ['prosa indentada antes de qualquer chave', '---\n    código de exemplo\nnome: x\n---\nResto\n'],
    ['`---abc` não fecha o bloco', '---\nname: x\n---abc\n# Corpo\n'],
    ['régua de dez hifens não fecha o bloco', '---\nname: x\n----------\n# Corpo\n'],
    ['fechamento malformado seguido de uma régua', '---\nname: x\n---abc\n# Corpo\n\n---\n\nFim\n'],
  ])('não descarta o que não é frontmatter: %s', (_caso, fonte) => {
    expect(stripFrontmatter(fonte)).toBe(fonte);
    expect(parseFrontmatter(fonte)).toEqual({ data: {}, body: fonte });
  });

  it('tolera espaço depois do `---` de abertura, como já tolerava no de fechamento', () => {
    expect(stripFrontmatter('--- \nname: x\n---\ncorpo')).toBe('corpo');
    expect(stripFrontmatter('---\t\r\nname: x\r\n---\r\ncorpo')).toBe('corpo');
  });

  it('acha o frontmatter atrás de linhas em branco num passe só', () => {
    // O `^\s+` rodava depois de procurar o bloco: o primeiro passe só aparava, e
    // era o passe seguinte (a leitura) que descartava o frontmatter.
    expect(stripFrontmatter('\n\n---\nname: x\n---\ncorpo')).toBe('corpo');
  });

  it('descarta de uma vez os blocos de frontmatter empilhados', () => {
    // Descartar só o primeiro deixava o resultado começando por outro bloco de
    // frontmatter, que o passe seguinte comia: a função não era idempotente.
    expect(stripFrontmatter('---\nname: x\n---\n---\nname: y\n---\n\nB\n')).toBe('B\n');
  });

  it('é idempotente de verdade: o segundo passe nunca muda o resultado do primeiro', () => {
    // A regra "tirar o frontmatter também na leitura, sem migração" depende
    // disto — o texto passa por até quatro passes num abrir-e-salvar do painel.
    const fontes = [
      '---\nname: x\n---\n---\nA\n---\nB',
      '---\nname: x\n---\n---\nname: y\n---\nB',
      '---\nname: x\n---\n\n\n---\nname: y\n---\n\n---\nC\n---\nD',
      '\n---\nname: x\n---\nB',
      '\uFEFF\n---\nname: x\n---\n---\n\nTexto\n\n---\nFim',
      '---\n\n# Título\n\nTexto\n\n---\n\nRodapé\n',
      '---\nname: x\n---abc\n# Corpo\n\n---\n\nFim\n',
      '--- \nname: x\n--- \n--- \nname: y\n---',
      '---\r\nname: x\r\n---\r\n---\r\nname: y\r\n---\r\nB\r\n',
      '---\n---\nname: x\n---\nB',
    ];
    for (const fonte of fontes) {
      const uma = stripFrontmatter(fonte);
      expect(stripFrontmatter(uma)).toBe(uma);
    }
  });

  it('remove o BOM antes de procurar o bloco', () => {
    expect(stripFrontmatter('﻿---\nname: x\n---\n# Corpo\n')).toBe('# Corpo\n');
  });
});

describe('buildFrontmatter', () => {
  it('usa o slug como nome oficial e joga título e tags em metadata', () => {
    expect(
      buildFrontmatter({
        slug: 'commit-conventional',
        name: 'Conventional Commits',
        description: 'Escreve mensagens de commit.',
        tags: ['git', 'workflow'],
      }),
    ).toBe(
      '---\n' +
        'name: commit-conventional\n' +
        'description: Escreve mensagens de commit.\n' +
        'metadata:\n' +
        '  title: Conventional Commits\n' +
        '  tags: git, workflow\n' +
        '---\n',
    );
  });

  it('cita valores que o YAML leria como outra coisa', () => {
    const yaml = buildFrontmatter({ slug: 'x', name: '', description: 'Faz X: e Y' });
    expect(yaml).toContain('description: "Faz X: e Y"');
  });

  it('escapa aspas e barras invertidas', () => {
    const yaml = buildFrontmatter({ slug: 'x', description: 'Diz "olá": \\ fim' });
    expect(yaml).toContain('description: "Diz \\"olá\\": \\\\ fim"');
    expect(parseFrontmatter(yaml).data.description).toBe('Diz "olá": \\ fim');
  });

  it('achata quebras de linha da descrição', () => {
    const yaml = buildFrontmatter({ slug: 'x', description: 'linha um\nlinha dois' });
    expect(yaml).toContain('description: linha um linha dois');
  });

  it('omite o bloco metadata quando não há título nem tags', () => {
    expect(buildFrontmatter({ slug: 'x', description: 'Faz X' })).toBe(
      '---\nname: x\ndescription: Faz X\n---\n',
    );
  });

  it('mantém a descrição vazia como escalar citado', () => {
    expect(buildFrontmatter({ slug: 'x' })).toContain('description: ""');
  });
});

/**
 * A exigência que este bloco segura é da SEP-2640
 * (`docs/17-skills-extension.md` §6.1): o `frontmatter` da entrada de
 * `skills/list` tem de bater **campo a campo** com o bloco YAML que o
 * `resources/read` devolve, e o host que achar diferença recusa a skill. Como
 * nada neste repositório lê o JSON de volta, uma divergência passaria em
 * silêncio daqui até o host de outra pessoa.
 *
 * Por isso a comparação é do resultado de um lado com o **parse** do outro, e
 * com `toEqual` no mapa inteiro: mexer só numa das funções — acrescentar campo,
 * mudar critério de ausência, parar de achatar um valor — derruba estes casos.
 */
describe('frontmatterObject espelha o frontmatter servido', () => {
  /**
   * O objeto no mesmo mapa raso que `parseFrontmatter` devolve: o parser do
   * projeto não tem hierarquia, e lê `title` e `tags` do bloco `metadata:` como
   * chaves de primeiro nível. A linha `metadata:` em si, que abre o bloco e não
   * tem valor, sobra no mapa como chave vazia — é artefato do parser, e está
   * aqui para a comparação poder ser do mapa inteiro.
   */
  const achatado = (objeto: Record<string, unknown>): Record<string, unknown> => {
    const { metadata, ...raiz } = objeto;
    return metadata ? { ...raiz, metadata: '', ...(metadata as Record<string, unknown>) } : raiz;
  };

  const casos: [string, SkillMeta][] = [
    ['completo', { slug: 'commit-conventional', name: 'Conventional Commits', description: 'Escreve commits.', tags: ['git', 'workflow'] }],
    ['sem nome de exibição', { slug: 'x', description: 'Faz X', tags: ['git'] }],
    ['sem tags', { slug: 'x', name: 'Título', description: 'Faz X' }],
    ['sem nome e sem tags', { slug: 'x', description: 'Faz X' }],
    ['sem descrição', { slug: 'x' }],
    ['descrição com dois-pontos e aspas', { slug: 'x', description: 'Diz "olá": \\ fim', name: 'Um: dois' }],
    ['tag com vírgula', { slug: 'x', description: 'Faz X', tags: ['a, b', 'c'] }],
    ['descrição em várias linhas', { slug: 'x', description: 'linha um\n  linha dois' }],
    ['campos só com espaço', { slug: 'x', name: '  ', description: '  ', tags: ['  ', 'git'] }],
    ['descrição que parece número', { slug: 'x', description: '42' }],
  ];

  it.each(casos)('%s: o YAML lido de volta é o objeto', (_nome, meta) => {
    expect(achatado(frontmatterObject(meta))).toEqual(parseFrontmatter(buildFrontmatter(meta)).data);
  });

  it('o bloco metadata do YAML é um objeto aninhado no JSON, não duas chaves soltas', () => {
    expect(frontmatterObject({ slug: 'x', name: 'Título', description: 'Faz X', tags: ['git'] })).toEqual({
      name: 'x',
      description: 'Faz X',
      metadata: { title: 'Título', tags: 'git' },
    });
  });

  // `tags` é string, como o YAML a escreve, e não lista: o objeto e o bloco têm
  // de dizer a mesma coisa, e virar lista mudaria os bytes do SKILL.md que o
  // `.zip` e o `/files/SKILL.md` já entregam (decisão 14 do `docs/17`).
  it('tags sai como string separada por vírgula, nunca como lista', () => {
    const { metadata } = frontmatterObject({ slug: 'x', tags: ['git', 'ci'] }) as {
      metadata: Record<string, unknown>;
    };
    expect(metadata.tags).toBe('git, ci');
  });

  it('não emite metadata vazio quando não há nome de exibição nem tag', () => {
    expect(frontmatterObject({ slug: 'x', description: 'Faz X' })).not.toHaveProperty('metadata');
  });
});

describe('composeSkillMd', () => {
  const meta = { slug: 'minha-skill', name: 'Minha Skill', description: 'Faz X' };

  it('põe os metadados nas primeiras linhas, antes do corpo', () => {
    expect(composeSkillMd(meta, '# Título\n')).toBe(
      '---\nname: minha-skill\ndescription: Faz X\nmetadata:\n  title: Minha Skill\n---\n\n# Título\n',
    );
  });

  it('descarta o frontmatter que vier no corpo — o formulário é a fonte da verdade', () => {
    const composto = composeSkillMd(meta, '---\nname: outra-coisa\ndescription: mentira\n---\n# Título\n');
    expect(composto).not.toContain('outra-coisa');
    expect(composto).not.toContain('mentira');
    expect(composto).toContain('name: minha-skill');
  });

  it('é idempotente: recompor o resultado devolve o mesmo documento', () => {
    const uma = composeSkillMd(meta, '# Título\n');
    expect(composeSkillMd(meta, uma)).toBe(uma);
  });

  it('devolve só o frontmatter quando o corpo está vazio', () => {
    expect(composeSkillMd(meta, '   \n')).toBe(
      '---\nname: minha-skill\ndescription: Faz X\nmetadata:\n  title: Minha Skill\n---\n',
    );
  });

  it('mantém inteiro o corpo que abre com uma régua horizontal, e segue idempotente', () => {
    const corpo = '---\n\n# Preâmbulo\n\nTexto\n\n---\n\nResto\n';
    const uma = composeSkillMd(meta, corpo);
    expect(uma).toBe(
      `---\nname: minha-skill\ndescription: Faz X\nmetadata:\n  title: Minha Skill\n---\n\n${corpo}`,
    );
    expect(composeSkillMd(meta, uma)).toBe(uma);
    expect(stripFrontmatter(uma)).toBe(corpo);
  });
});

describe('skillMetaFromMarkdown', () => {
  it('prefere os campos do frontmatter', () => {
    const meta = skillMetaFromMarkdown('---\nname: A\ndescription: B\n---\n# Outro\n\nParágrafo.');
    expect(meta.name).toBe('A');
    expect(meta.description).toBe('B');
  });

  it('trata um `name` em forma de slug como slug e busca o título em metadata', () => {
    const meta = skillMetaFromMarkdown(
      '---\nname: minha-skill\ndescription: Faz X\nmetadata:\n  title: Minha Skill\n  tags: git, ci\n---\n# Outro\n',
    );
    expect(meta).toEqual({
      name: 'Minha Skill',
      description: 'Faz X',
      slug: 'minha-skill',
      tags: ['git', 'ci'],
    });
  });

  it('sem título em metadata, o nome legível vem do primeiro heading', () => {
    const meta = skillMetaFromMarkdown('---\nname: minha-skill\n---\n# Minha Skill\n\nFaz X.');
    expect(meta.name).toBe('Minha Skill');
    expect(meta.slug).toBe('minha-skill');
  });

  it('cai para o primeiro heading e o primeiro parágrafo', () => {
    const meta = skillMetaFromMarkdown('# Título da Skill\n\nEla faz coisas\nem várias linhas.\n\nOutro parágrafo.');
    expect(meta.name).toBe('Título da Skill');
    expect(meta.description).toBe('Ela faz coisas em várias linhas.');
    expect(meta.slug).toBeNull();
  });

  it('devolve null quando não há nada aproveitável', () => {
    expect(skillMetaFromMarkdown('')).toEqual({
      name: null,
      description: null,
      slug: null,
      tags: [],
    });
  });

  it('a descrição em escalar de bloco chega inteira, e não como ">-"', () => {
    const meta = skillMetaFromMarkdown(
      '---\nname: pdf-tools\ndescription: >-\n  Use quando o usuário quiser extrair, juntar\n  ou dividir PDFs.\n---\n# PDF Tools\n\nCorpo.\n',
    );
    expect(meta).toEqual({
      name: 'PDF Tools',
      description: 'Use quando o usuário quiser extrair, juntar ou dividir PDFs.',
      slug: 'pdf-tools',
      tags: [],
    });
  });

  it('`description:` vazia cai para o próximo candidato, em vez de nascer vazia', () => {
    // O `??` só pulava a chave AUSENTE: presente e vazia, ela vencia o `summary`
    // e o primeiro parágrafo, e a skill nascia sem descrição.
    for (const vazia of ['description:', 'description: ""', "description: ''", 'description: >-']) {
      expect(skillMetaFromMarkdown(`---\nname: a\n${vazia}\n---\n# Título\n\nPrimeiro parágrafo.\n`).description).toBe(
        'Primeiro parágrafo.',
      );
    }
    expect(skillMetaFromMarkdown('---\nname: a\ndescription:\nsummary: Do resumo\n---\ncorpo').description).toBe('Do resumo');
  });

  it('o corpo que abre com uma régua não perde o título nem o primeiro parágrafo', () => {
    // O trecho entre as duas réguas era tratado como frontmatter sem chave
    // nenhuma, e nome e descrição saíam do que vinha DEPOIS dele.
    const meta = skillMetaFromMarkdown('---\n\n# Título\n\nTexto\n\n---\n\nRodapé\n');
    expect(meta.name).toBe('Título');
    // E a própria régua não é parágrafo.
    expect(meta.description).toBe('Texto');
  });

  it('faz round-trip de uma descrição com quebras de linha, que sai achatada', () => {
    const original = { slug: 'minha-skill', description: 'Linha um.\nLinha dois: com dois pontos.' };
    const meta = skillMetaFromMarkdown(composeSkillMd(original, '# Corpo\n'));
    expect(meta.description).toBe('Linha um. Linha dois: com dois pontos.');
  });

  it('faz round-trip com buildFrontmatter', () => {
    const original = {
      slug: 'minha-skill',
      name: 'Minha Skill',
      description: 'Faz X, Y e Z.',
      tags: ['git', 'ci'],
    };
    const meta = skillMetaFromMarkdown(composeSkillMd(original, '# Corpo\n'));
    expect(meta).toEqual({
      name: original.name,
      description: original.description,
      slug: original.slug,
      tags: original.tags,
    });
  });

  // Onde a skill aparece é decidido pelo vínculo a um vMCP, nunca pelo
  // arquivo: um `.zip` de terceiro não se publica sozinho.
  it('ignora qualquer flag de publicação que venha no frontmatter', () => {
    const meta = skillMetaFromMarkdown(
      '---\nname: a\nis_public: true\nuse_as_prompt: true\nmetadata:\n  use_as_resource: true\n---\ncorpo',
    );
    expect(meta).toEqual({ name: 'a', description: 'corpo', slug: 'a', tags: [] });
  });
});
