import { describe, expect, it } from 'vitest';
import type { ArchiveEntry } from './archive.js';
import { DEFAULT_MAX_BUNDLE_SKILLS, splitBundle } from './bundle.js';
import type { BundleSkillDir } from './bundle.js';
import { ZipError, ZipLimitError } from './zip.js';

/**
 * Monta as entradas cruas de um pacote. O conteúdo carrega o caminho de origem
 * porque alguns testes precisam saber de onde cada arquivo veio depois de o
 * caminho ter sido rebaseado.
 */
function pacote(...paths: string[]): ArchiveEntry[] {
  return paths.map((path) => ({ path, data: Buffer.from(`conteúdo de ${path}`, 'utf8') }));
}

/** `{ 'skills/a': ['SKILL.md', 'ref/x.md'] }` — o retrato que quase todo teste confere. */
function porDiretorio(skills: readonly BundleSkillDir[]): Record<string, string[]> {
  return Object.fromEntries(skills.map((skill) => [skill.dir, skill.files.map((f) => f.path)]));
}

describe('splitBundle', () => {
  it('rebaseia os caminhos: o SKILL.md volta para a raiz do envio', () => {
    const { skills, skipped } = splitBundle(pacote('archive/skills/how-to-use-fping/SKILL.md'));

    expect(skipped).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0].dir).toBe('archive/skills/how-to-use-fping');
    expect(skills[0].files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('entrega os bytes que vieram, sem tocar no conteúdo', () => {
    const { skills } = splitBundle(pacote('skills/a/SKILL.md', 'skills/a/ref/guia.md'));
    const guia = skills[0].files.find((f) => f.path === 'ref/guia.md');

    expect(guia?.data.toString('utf8')).toBe('conteúdo de skills/a/ref/guia.md');
  });

  it('leva as subpastas da skill junto', () => {
    const { skills } = splitBundle(
      pacote(
        'skills/pingar/SKILL.md',
        'skills/pingar/ref/guia.md',
        'skills/pingar/ref/fundo/detalhe.md',
        'skills/pingar/scripts/run.py',
      ),
    );

    expect(porDiretorio(skills)).toEqual({
      'skills/pingar': ['SKILL.md', 'ref/fundo/detalhe.md', 'ref/guia.md', 'scripts/run.py'],
    });
  });

  it('num repositório de terceiro, só o diretório com SKILL.md vira skill', () => {
    // O `.zip` do GitHub traz o repositório inteiro. Nada fora das skills entra
    // em envio nenhum: sem essa regra, `.github/` e `src/` viriam de carona na
    // primeira skill que os contivesse.
    const { skills, skipped } = splitBundle(
      pacote(
        'superpowers-main/README.md',
        'superpowers-main/LICENSE',
        'superpowers-main/.github/workflows/ci.yml',
        'superpowers-main/src/index.ts',
        'superpowers-main/docs/uso.md',
        'superpowers-main/skills/brainstorming/SKILL.md',
        'superpowers-main/skills/brainstorming/ref/exemplos.md',
        'superpowers-main/skills/debugging/SKILL.md',
      ),
    );

    expect(skipped).toEqual([]);
    expect(porDiretorio(skills)).toEqual({
      'superpowers-main/skills/brainstorming': ['SKILL.md', 'ref/exemplos.md'],
      'superpowers-main/skills/debugging': ['SKILL.md'],
    });
  });

  it('a raiz do pacote é um diretório como outro qualquer', () => {
    const { skills } = splitBundle(pacote('SKILL.md', 'ref/guia.md', 'scripts/run.py'));

    expect(skills).toHaveLength(1);
    expect(skills[0].dir).toBe('');
    expect(skills[0].files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'ref/guia.md',
      'scripts/run.py',
    ]);
  });

  it('skill na raiz não engole a que está dentro dela', () => {
    const { skills } = splitBundle(pacote('SKILL.md', 'nota.md', 'exemplos/SKILL.md'));

    expect(porDiretorio(skills)).toEqual({
      '': ['SKILL.md', 'nota.md'],
      exemplos: ['SKILL.md'],
    });
  });

  it('skill dentro de skill: saem as duas, e a filha não aparece na mãe', () => {
    // Sem a regra, `a/b/guia.md` iria nos dois envios e a mãe ainda ganharia um
    // segundo `SKILL.md` — em `b/SKILL.md`, no meio da própria árvore.
    const { skills } = splitBundle(
      pacote('a/SKILL.md', 'a/nota.md', 'a/b/SKILL.md', 'a/b/guia.md', 'a/b/c/fundo.md'),
    );

    expect(porDiretorio(skills)).toEqual({
      a: ['SKILL.md', 'nota.md'],
      'a/b': ['SKILL.md', 'c/fundo.md', 'guia.md'],
    });
  });

  it('uma pasta chamada skill/ com SKILL.md dentro é uma skill nova', () => {
    // A pasta se chamar `skill` não muda nada: quem decide é o arquivo.
    const { skills } = splitBundle(pacote('a/SKILL.md', 'a/skill/SKILL.md', 'a/skill/ref/x.md'));

    expect(porDiretorio(skills)).toEqual({
      a: ['SKILL.md'],
      'a/skill': ['SKILL.md', 'ref/x.md'],
    });
  });

  it('canoniza skill.md para SKILL.md no caminho rebaseado', () => {
    // A mesma razão de `paths.ts`: com as duas grafias convivendo, o envio fica
    // com duas linhas "principais" e o conteúdo exibido é escolhido sem critério.
    const { skills } = splitBundle(pacote('skills/minha/skill.md', 'skills/minha/ref/x.md'));

    expect(porDiretorio(skills)).toEqual({ 'skills/minha': ['SKILL.md', 'ref/x.md'] });
    expect(skills[0].files[0].data.toString('utf8')).toBe('conteúdo de skills/minha/skill.md');
  });

  it('as duas grafias do principal no mesmo diretório viram um arquivo só', () => {
    // `normalizeRelativePath` leva as duas para `SKILL.md`; entregar as duas
    // devolveria uma casa adiante o problema que ela evita — duas linhas
    // "principais" no mesmo envio. Fica a do caminho de origem menor, sempre a
    // mesma qualquer que tenha sido a ordem do pacote.
    const { skills } = splitBundle(pacote('a/skill.md', 'a/SKILL.md', 'a/x.md'));
    const avesso = splitBundle(pacote('a/SKILL.md', 'a/skill.md', 'a/x.md'));

    expect(porDiretorio(skills)).toEqual({ a: ['SKILL.md', 'x.md'] });
    expect(skills[0].files[0].data.toString('utf8')).toBe('conteúdo de a/SKILL.md');
    expect(avesso.skills[0].files[0].data.toString('utf8')).toBe('conteúdo de a/SKILL.md');
  });

  it('SKILL.md.bak e NOTSKILL.md não fazem diretório nenhum virar skill', () => {
    // O nome é comparado inteiro, não por sufixo.
    const { skills, skipped } = splitBundle(
      pacote('a/SKILL.md.bak', 'b/NOTSKILL.md', 'c/SKILL.mdx', 'd/ref/SKILL.md'),
    );

    expect(skipped).toEqual([]);
    expect(porDiretorio(skills)).toEqual({ 'd/ref': ['SKILL.md'] });
  });

  it('não depende da ordem em que os arquivos vieram', () => {
    const caminhos = [
      'skills/zebra/SKILL.md',
      'skills/zebra/ref/z.md',
      'skills/alfa/SKILL.md',
      'skills/alfa/scripts/run.py',
      'skills/alfa/ref/a.md',
      'skills/meio/skill.md',
      'README.md',
    ];
    const embaralhado = [...caminhos].reverse();

    const direto = splitBundle(pacote(...caminhos));
    const avesso = splitBundle(pacote(...embaralhado));

    expect(direto.skills.map((s) => s.dir)).toEqual([
      'skills/alfa',
      'skills/meio',
      'skills/zebra',
    ]);
    expect(direto.skills[0].files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'ref/a.md',
      'scripts/run.py',
    ]);
    expect(porDiretorio(avesso.skills)).toEqual(porDiretorio(direto.skills));
    expect(avesso.skills.map((s) => s.dir)).toEqual(direto.skills.map((s) => s.dir));
  });

  it('entrada vazia devolve listas vazias, sem lançar', () => {
    expect(splitBundle([])).toEqual({ skills: [], skipped: [] });
  });

  it('pacote sem SKILL.md nenhum não é erro: quem decide o que fazer é a rota', () => {
    expect(splitBundle(pacote('README.md', 'src/index.ts'))).toEqual({ skills: [], skipped: [] });
  });

  it('aplica os tetos padrão quando não recebe opção', () => {
    // Um padrão que virasse `NaN` ou `0` puliria toda skill em silêncio.
    expect(Number.isSafeInteger(DEFAULT_MAX_BUNDLE_SKILLS)).toBe(true);
    expect(DEFAULT_MAX_BUNDLE_SKILLS).toBeGreaterThan(0);

    const { skills, skipped } = splitBundle(pacote('a/SKILL.md', 'b/SKILL.md', 'b/ref/x.md'));
    expect(skills.map((s) => s.dir)).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });
});

describe('splitBundle — teto de arquivos por skill', () => {
  it('pula a skill inchada e deixa as irmãs entrarem', () => {
    // Decisão do mantenedor: num repositório de 40 skills, o diretório que
    // passou do teto sai sozinho da lista em vez de derrubar a importação.
    const gigante = ['skills/gigante/SKILL.md'];
    for (let i = 0; i < 5; i += 1) gigante.push(`skills/gigante/ref/f${i}.md`);

    const { skills, skipped } = splitBundle(
      pacote(...gigante, 'skills/magra/SKILL.md', 'skills/magra/ref/x.md'),
      { maxFilesPerSkill: 3 },
    );

    expect(porDiretorio(skills)).toEqual({ 'skills/magra': ['SKILL.md', 'ref/x.md'] });
    expect(skipped).toEqual([{ dir: 'skills/gigante', reason: 'too_many_files', fileCount: 6 }]);
  });

  it('a skill exatamente no teto entra', () => {
    const { skills, skipped } = splitBundle(pacote('a/SKILL.md', 'a/x.md', 'a/y.md'), {
      maxFilesPerSkill: 3,
    });

    expect(skipped).toEqual([]);
    expect(skills[0].files).toHaveLength(3);
  });

  it('as puladas também saem em ordem determinística', () => {
    const { skipped } = splitBundle(
      pacote('z/SKILL.md', 'z/a.md', 'a/SKILL.md', 'a/a.md', 'm/SKILL.md', 'm/a.md'),
      { maxFilesPerSkill: 1 },
    );

    expect(skipped.map((s) => s.dir)).toEqual(['a', 'm', 'z']);
  });
});

describe('splitBundle — teto de skills no pacote', () => {
  it('recusa o pacote com skills demais, dizendo quantas e qual é o teto', () => {
    const entries = pacote('a/SKILL.md', 'b/SKILL.md', 'c/SKILL.md');

    expect(() => splitBundle(entries, { maxSkills: 2 })).toThrow(ZipLimitError);
    // A borda HTTP (`api.ts`) mapeia `ZipError` para 400; um Error solto viraria 500.
    expect(() => splitBundle(entries, { maxSkills: 2 })).toThrow(ZipError);
    expect(() => splitBundle(entries, { maxSkills: 2 })).toThrow(/\(3 /);
    expect(() => splitBundle(entries, { maxSkills: 2 })).toThrow(/limite é 2/);
  });

  it('conta as skills que seriam puladas: o teto é sobre o que o pacote traz', () => {
    // Senão um pacote de milhares de diretórios inchados passaria pelo limite
    // só porque nenhum deles entraria na fila.
    const entries = pacote('a/SKILL.md', 'b/SKILL.md', 'b/x.md', 'b/y.md');

    expect(() => splitBundle(entries, { maxSkills: 1, maxFilesPerSkill: 1 })).toThrow(
      ZipLimitError,
    );
  });

  it('deixa passar o pacote exatamente no teto', () => {
    const { skills } = splitBundle(pacote('a/SKILL.md', 'b/SKILL.md'), { maxSkills: 2 });
    expect(skills.map((s) => s.dir)).toEqual(['a', 'b']);
  });
});
