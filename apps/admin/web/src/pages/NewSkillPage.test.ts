import { describe, expect, it } from 'vitest';
// `?raw` é do Vite (e o Vitest o entende): o **texto** do arquivo, sem avaliar
// nada — como em `audit.test.ts`. Este bundle é de navegador: importar o
// `archive.ts` de verdade traria `node:zlib` e o `tar-stream` para dentro dele.
import fonteDoArchive from '../../../../../packages/shared/src/archive.ts?raw';
import { ACCEPT_PACOTE, FORMATOS_NA_TELA, MOTIVO_PULADA } from './NewSkillPage.js';
import type { QuarantineImportResult } from '../api.js';

/**
 * `POST /api/skills/import` para a quarentena responde **dois** corpos na mesma
 * rota (`docs/15-quarentena.md`): uma skill volta como a ficha do envio, duas
 * ou mais voltam como bundle. Tudo o que separa "vai direto para a ficha" de
 * "mostra o resultado na tela" é o `'bundle' in resposta`, então os dois corpos
 * do contrato ficam fixados aqui — montados como o servidor os manda, e com o
 * tipo do pacote compartilhado, de modo que o typecheck dos testes cobre a
 * forma e o teste cobre o discriminador.
 */
describe('o corpo da importação para a quarentena', () => {
  const umaSkill: QuarantineImportResult = {
    uuid: '0f0f0f0f-0000-0000-0000-000000000001',
    name: 'Brainstorming',
    description: '',
    sourceFilename: 'brainstorming.zip',
    ownerUserUuid: null,
    ownerUsername: null,
    fileCount: 4,
    sizeBytes: 2048,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
    files: [],
  };

  const variasSkills: QuarantineImportResult = {
    bundle: true,
    sourceFilename: 'superpowers-main.zip',
    imported: [{ uuid: '0f0f0f0f-0000-0000-0000-000000000002', name: 'Brainstorming', path: 'skills/brainstorming', fileCount: 4 }],
    skipped: [{ path: 'skills/gigante', reason: 'too_many_files', fileCount: 900 }],
  };

  it('a ficha de um envio não se confunde com o bundle', () => {
    expect('bundle' in umaSkill).toBe(false);
    expect('bundle' in variasSkills).toBe(true);
  });

  it('o bundle traz o que entrou e o que ficou de fora separados', () => {
    if (!('bundle' in variasSkills)) throw new Error('o corpo do bundle deixou de ser reconhecido');
    expect(variasSkills.imported.map((item) => item.path)).toEqual(['skills/brainstorming']);
    expect(variasSkills.skipped.map((item) => item.path)).toEqual(['skills/gigante']);
  });
});

/**
 * Uma skill recusada não pode virar célula em branco nem código cru na tela:
 * quem importou 40 precisa ler, em português, por que aquela ficou de fora.
 */
describe('MOTIVO_PULADA', () => {
  it('todo motivo tem frase em português, nunca o código do contrato', () => {
    for (const [reason, frase] of Object.entries(MOTIVO_PULADA)) {
      expect(frase, reason).toMatch(/\S/);
      expect(frase, reason).not.toBe(reason);
    }
  });
});


/**
 * A lista canônica dos formatos é o `FORMATOS_ACEITOS` de
 * `packages/shared/src/archive.ts` (não o `dist/`, que engana:
 * `docs/03-implementation-notes.md`, "Armadilhas medidas…"): é ela que a
 * recusa 400 cita. A tela tem de mostrar a mesma, e o `accept` do seletor tem
 * de deixar todas escolhíveis.
 *
 * Medido: o `accept` trazia `.zst` mas não `.zstd`, e o navegador compara a
 * extensão inteira — um pacote `.zstd`, que o servidor abre, não aparecia no
 * diálogo de arquivo. A tela, por sua vez, enumerava cinco dos dez formatos.
 */
describe('os formatos aceitos na tela de importação', () => {
  /** Os sufixos de `'.a, .b e .c'`, na ordem em que estão escritos. */
  function extensoes(lista: string): string[] {
    return lista.split(/,\s*|\s+e\s+/).map((item) => item.trim()).filter((item) => item.length > 0);
  }

  const canonico = /const FORMATOS_ACEITOS = '([^']+)';/.exec(fonteDoArchive);
  if (!canonico) throw new Error('FORMATOS_ACEITOS não encontrado em packages/shared/src/archive.ts — o formato do arquivo mudou');
  const aceitos = extensoes(canonico[1]!);

  it('a lista da tela é a lista canônica, inteira', () => {
    expect(aceitos.length).toBeGreaterThan(1);
    expect(extensoes(FORMATOS_NA_TELA)).toEqual(aceitos);
  });

  it('o seletor de arquivo não esconde nenhum formato aceito', () => {
    // A regra do navegador, e não "tem a string dentro": o arquivo aparece
    // quando o nome **termina** em um dos sufixos do `accept`. É por isso que
    // `.gz` cobre `.tar.gz` e `.zst` não cobre `.zstd`.
    const sufixos = ACCEPT_PACOTE.split(',').filter((item) => item.startsWith('.'));
    for (const extensao of aceitos) {
      const coberta = sufixos.some((sufixo) => extensao.toLowerCase().endsWith(sufixo));
      expect(coberta, `${extensao} não casa com nenhum sufixo do accept e fica invisível no diálogo`).toBe(true);
    }
    const doSeletor = ACCEPT_PACOTE.split(',');
    // O pedido que revelou o defeito trazia um `.zstd`; o `.gzip` é o mesmo
    // caso do outro lado (`semSufixoDeCompressao`, no `archive.ts`).
    expect(doSeletor).toContain('.zstd');
    expect(doSeletor).toContain('.gzip');
  });
});
