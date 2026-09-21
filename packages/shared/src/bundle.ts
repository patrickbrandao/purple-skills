import type { ArchiveEntry } from './archive.js';
import { readIntEnv } from './env.js';
import { isSkillMd, normalizeRelativePath } from './paths.js';
import { DEFAULT_MAX_ZIP_ENTRIES, ZipLimitError } from './zip.js';

export type BundleSkillDir = {
  /** Diretório dentro do pacote; `''` quando a skill está na raiz. */
  dir: string;
  /** Arquivos já rebaseados: o `SKILL.md` fica na raiz do envio. */
  files: ArchiveEntry[];
};

export type BundleSkippedDir = {
  dir: string;
  reason: 'too_many_files';
  fileCount: number;
};

export type SplitBundleOptions = {
  /** Teto de arquivos de **uma** skill. Acima dele ela é pulada, não recusada. */
  maxFilesPerSkill?: number;
  /** Teto de skills no pacote inteiro. Acima dele, `ZipLimitError`. */
  maxSkills?: number;
};

/**
 * Teto padrão de skills num pacote.
 *
 * Lido com `readIntEnv` pela razão do cabeçalho de `env.ts`: um valor escrito
 * errado viraria `NaN`, toda comparação com `NaN` é falsa e o teto sairia do ar
 * em silêncio — justamente a proteção que a variável deveria configurar.
 */
export const DEFAULT_MAX_BUNDLE_SKILLS = readIntEnv('BUNDLE_MAX_SKILLS', 200);

/** Um arquivo já atribuído a uma skill, com o caminho de origem para desempate. */
type ArquivoDeSkill = {
  /** Caminho rebaseado, relativo à raiz da skill. */
  path: string;
  data: Buffer;
  /** Caminho como veio no pacote; só serve para a ordem ficar determinística. */
  origem: string;
};

/**
 * Separa um pacote com várias skills: uma skill por diretório que tenha um
 * `SKILL.md`, com os arquivos daquele diretório e das subpastas dele.
 *
 * Um repositório de terceiro chega inteiro — `.github/`, `docs/`, `src/`, o
 * `README.md` da raiz —, e nada disso é skill. O `SKILL.md` é o único sinal em
 * que dá para confiar: diretório que não tem um (nem está dentro de um que
 * tenha) é ignorado por completo, do mesmo jeito que `commonRootDir`
 * (`zip.ts`) só trata a pasta raiz como embrulho quando ela traz o `SKILL.md`.
 *
 * Não lança quando não há skill nenhuma: quem decide o que fazer com zero é a
 * rota, que responde coisas diferentes na quarentena e na produção.
 */
export function splitBundle(
  entries: readonly ArchiveEntry[],
  options: SplitBundleOptions = {},
): { skills: BundleSkillDir[]; skipped: BundleSkippedDir[] } {
  const { maxFilesPerSkill = DEFAULT_MAX_ZIP_ENTRIES, maxSkills = DEFAULT_MAX_BUNDLE_SKILLS } =
    options;

  // O nome do arquivo é comparado inteiro, sem diferenciar a caixa: `skill.md`
  // vale, `SKILL.md.bak` e `NOTSKILL.md` não. A raiz do pacote é o `dir` vazio.
  const skillDirs = new Set<string>();
  for (const entry of entries) {
    const { dir, name } = separarCaminho(entry.path);
    if (isSkillMd(name)) skillDirs.add(dir);
  }

  // O teto é sobre o que o pacote **traz**, não sobre o que sobra: as skills
  // que seriam puladas por tamanho contam aqui, senão um pacote com milhares de
  // diretórios inchados passaria pelo limite só porque nenhum deles entraria.
  // Conferido antes de agrupar, que é a parte cara.
  if (skillDirs.size > maxSkills) {
    throw new ZipLimitError(
      `O pacote tem skills demais (${skillDirs.size} diretórios com SKILL.md); ` +
        `o limite é ${maxSkills}.`,
    );
  }

  const porSkill = new Map<string, ArquivoDeSkill[]>();
  for (const dir of skillDirs) porSkill.set(dir, []);

  for (const entry of entries) {
    const { dir } = separarCaminho(entry.path);
    const dono = skillMaisFunda(dir, skillDirs);
    if (dono === null) continue;

    const relativo = dono === '' ? entry.path : entry.path.slice(dono.length + 1);
    // `normalizeRelativePath` é o que canoniza `skill.md` para `SKILL.md`
    // (o porquê está em `paths.ts`): sem ele, duas grafias viram duas linhas
    // "principais" no mesmo envio e o conteúdo exibido passa a ser escolhido
    // sem critério entre as duas. Devolve `null` para o que não sobrevive ao
    // rebase — o caminho que aponta para o próprio diretório da skill.
    const path = normalizeRelativePath(relativo);
    if (!path) continue;

    porSkill.get(dono)?.push({ path, data: entry.data, origem: entry.path });
  }

  const skills: BundleSkillDir[] = [];
  const skipped: BundleSkippedDir[] = [];

  for (const [dir, arquivos] of porSkill) {
    const files = ordenarArquivos(arquivos);
    if (files.length > maxFilesPerSkill) {
      // Decisão do mantenedor: um diretório inchado no meio de um repositório
      // de 40 skills pula sozinho e é reportado, em vez de derrubar a
      // importação inteira. As irmãs entram normalmente.
      skipped.push({ dir, reason: 'too_many_files', fileCount: files.length });
      continue;
    }
    skills.push({ dir, files });
  }

  // A ordem de `porSkill` é a de aparição no pacote, que não é ordem nenhuma:
  // o mesmo repositório empacotado duas vezes sairia em ordens diferentes.
  skills.sort((a, b) => compararTexto(a.dir, b.dir));
  skipped.sort((a, b) => compararTexto(a.dir, b.dir));

  return { skills, skipped };
}

/** Divide o caminho em diretório (sem a barra final; `''` na raiz) e nome. */
function separarCaminho(path: string): { dir: string; name: string } {
  const corte = path.lastIndexOf('/');
  return corte < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, corte), name: path.slice(corte + 1) };
}

/**
 * O diretório de skill **mais fundo** que contém `dir`, ou `null` quando
 * nenhum contém — o caso de `.github/` e `src/`, que não entram em skill alguma.
 *
 * Mais fundo, e não mais raso, é o que separa mãe de filha: com `a/SKILL.md` e
 * `a/b/SKILL.md`, o que está em `a/b/` é só da filha. Pela mãe os arquivos
 * apareceriam nos dois envios e ela ainda ganharia um segundo `SKILL.md` no
 * meio da própria árvore.
 */
function skillMaisFunda(dir: string, skillDirs: ReadonlySet<string>): string | null {
  let atual = dir;
  while (atual !== '') {
    if (skillDirs.has(atual)) return atual;
    const corte = atual.lastIndexOf('/');
    atual = corte < 0 ? '' : atual.slice(0, corte);
  }
  return skillDirs.has('') ? '' : null;
}

/**
 * Ordena os arquivos de uma skill — `SKILL.md` primeiro, o resto pelo caminho —
 * e descarta a repetição que o rebase pode criar.
 *
 * `a/SKILL.md` e `a/skill.md` no mesmo diretório viram os dois `SKILL.md`
 * depois de `normalizeRelativePath`; entregar os dois recriaria uma casa
 * adiante exatamente o problema que aquela canonização evita. Fica o primeiro
 * da ordem, e o desempate pelo caminho de origem faz com que seja sempre o
 * mesmo, qualquer que tenha sido a ordem do pacote.
 */
function ordenarArquivos(arquivos: ArquivoDeSkill[]): ArchiveEntry[] {
  arquivos.sort((a, b) => {
    const aPrincipal = isSkillMd(a.path);
    const bPrincipal = isSkillMd(b.path);
    if (aPrincipal !== bPrincipal) return aPrincipal ? -1 : 1;
    return compararTexto(a.path, b.path) || compararTexto(a.origem, b.origem);
  });

  const vistos = new Set<string>();
  const files: ArchiveEntry[] = [];
  for (const arquivo of arquivos) {
    if (vistos.has(arquivo.path)) continue;
    vistos.add(arquivo.path);
    files.push({ path: arquivo.path, data: arquivo.data });
  }

  return files;
}

/**
 * Comparação de string simples, byte a byte. `localeCompare` muda com a locale
 * do processo — a mesma lista sairia em ordens diferentes em máquinas
 * diferentes, e a ordem aqui é o que o usuário vê na fila da quarentena.
 */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
