import { createHash } from 'node:crypto';

/** O que a entrada de `skills/list` publica sobre um arquivo: o digest e o tamanho em bytes. */
export type Digesto = { digest: string; size: number };

/**
 * O que se sabe do `SKILL.md` composto de uma skill: o par publicável, ou o
 * marcador de skill sem manifesto verificável (`"dynamic"`, §5.4 do
 * `docs/17-skills-extension.md`) — que é o caso em que o `resources/read`
 * recusaria o mesmo conteúdo por tamanho.
 */
export type SkillMdMedido = Digesto | 'dynamic';

/**
 * Teto de entradas do cache. Sem ele, um processo de vida longa acabaria com o
 * digest de todo `SKILL.md` já listado na memória — e quem decide quantos são é
 * quem chama a listagem, não o operador.
 *
 * O número é folgado de propósito: uma entrada são duas strings curtas (a chave
 * e o hexadecimal) e um número, algumas centenas de bytes, e o catálogo de uma
 * instalação self-hosted raramente passa de algumas dezenas de skills. Ele está
 * aqui para limitar o pior caso, não para apertar o caso normal — por isso não
 * vira variável de ambiente: não há o que ajustar.
 */
const MAX_ENTRADAS = 2048;

/**
 * Mede o `SKILL.md` **composto** — corpo mais o frontmatter remontado —, que é
 * exatamente o que o `resources/read` devolve.
 *
 * Não é o `content_sha256` da linha de `files`: aquele é o hash do corpo
 * gravado, **sem** frontmatter (§5.2 do `docs/17-skills-extension.md`).
 * Publicá-lo faria toda skill falhar na verificação de todo host, em silêncio,
 * porque nada deste repositório lê o digest de volta.
 */
export function medirSkillMd(composto: string): Digesto {
  return {
    digest: `sha256:${createHash('sha256').update(composto, 'utf8').digest('hex')}`,
    size: Buffer.byteLength(composto, 'utf8'),
  };
}

/**
 * O cache do digest do `SKILL.md`, chaveado por `(uuid, updated_at)` (decisão
 * 24). Sem ele, `skills/list` lê o corpo de todo `SKILL.md` do vMCP a cada
 * chamada: num vMCP aberto não há credencial e o rate limit padrão são 600
 * requisições por minuto por IP, o que faz disso amplificação, não escala.
 *
 * A chave é sólida porque o `updated_at` da skill se move sozinho nos dois
 * casos que mudam o arquivo composto: `planSkillUpdate` empurra `now()` em todo
 * `updateSkill` — inclusive numa troca só de tags, que muda o frontmatter — e o
 * trigger `files_reindex_skill_tg` da `001` toca a skill quando a linha alterada
 * é o `SKILL.md`. Entrada velha nunca é servida: ela simplesmente deixa de ser
 * procurada, e sai pelo teto.
 *
 * Guarda **só** a medida, nunca o texto composto: guardar o texto seria trocar
 * uma leitura por skill por um catálogo inteiro residente na memória.
 */
export function criarCacheDeDigesto(maxEntradas: number = MAX_ENTRADAS) {
  const entradas = new Map<string, SkillMdMedido>();

  // Um separador que não é byte de controle, pela regra do `AGENTS.md`. O `@`
  // serve: nem uuid nem timestamp ISO o contêm, então a chave não é ambígua.
  const chave = (uuid: string, updatedAt: string) => `${uuid}@${updatedAt}`;

  return {
    /** A medida conhecida daquela versão da skill, ou nada — e aí é preciso ler o corpo. */
    ler(uuid: string, updatedAt: string): SkillMdMedido | undefined {
      return entradas.get(chave(uuid, updatedAt));
    },

    /**
     * Guarda a medida e devolve a mesma, para quem chama encadear.
     *
     * O descarte é por ordem de inserção, e não por uso: a entrada de uma
     * versão que ninguém mais pede já está morta — a chave dela nunca mais será
     * procurada —, então promover quem foi lido agora não mudaria o que vale a
     * pena manter. `Map` preserva a ordem de inserção, então o primeiro `key` é
     * o mais antigo.
     */
    guardar(uuid: string, updatedAt: string, medida: SkillMdMedido): SkillMdMedido {
      entradas.set(chave(uuid, updatedAt), medida);
      while (entradas.size > maxEntradas) {
        const maisAntiga = entradas.keys().next();
        if (maisAntiga.done) break;
        entradas.delete(maisAntiga.value);
      }
      return medida;
    },

    /** Esvazia o cache. Existe para o teste poder partir de um estado conhecido. */
    limpar(): void {
      entradas.clear();
    },

    get tamanho(): number {
      return entradas.size;
    },
  };
}

/**
 * O cache do processo, e não da instância do servidor: `createMcpServer` roda
 * por sessão e, no transporte stateless, **por requisição** — um cache dentro
 * da instância nasceria frio a cada chamada, isto é, não existiria.
 *
 * É compartilhado por todos os vMCPs de propósito: a composição do `SKILL.md`
 * não depende do vMCP que a serve, então a chave é global e continua correta.
 */
export const cacheDeDigesto = criarCacheDeDigesto();
