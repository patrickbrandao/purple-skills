import { describe, expect, it } from 'vitest';
import { modeloDaTela, pendenciasDe, resumoDasPendencias, ROTULO_DA_CHAVE } from './RagPanel.js';
import type { RagCoverage, RagValue } from '../api.js';

const valor = (value: string, origem: RagValue['origem'] = 'banco'): RagValue => ({
  value,
  origem,
  updatedAt: null,
  ambienteIgnorado: null,
});

const DRIVERS = [
  { id: 'google', label: 'Google — Gemini API', models: ['gemini-embedding-2'] },
  { id: 'openai', label: 'OpenAI', models: ['text-embedding-3-small', 'text-embedding-3-large'] },
];

describe('o modelo com que a tela abre', () => {
  it('é o gravado, quando ele é do driver gravado', () => {
    expect(
      modeloDaTela({
        driver: valor('openai'),
        model: valor('text-embedding-3-large'),
        driverOptions: DRIVERS,
      }),
    ).toBe('text-embedding-3-large');
  });

  it('par que não combina: abre no primeiro modelo do driver, e a tela fica por salvar', () => {
    // google + text-embedding-3-large é o que a semeadura gravava até a beta.22.
    // O Google tem um modelo só: sem isto o select nunca dispararia `onChange`,
    // e o "Salvar" que conserta o par ficaria desabilitado para sempre.
    const dados = {
      driver: valor('google'),
      model: valor('text-embedding-3-large'),
      driverOptions: DRIVERS,
    };
    expect(modeloDaTela(dados)).toBe('gemini-embedding-2');
    expect(modeloDaTela(dados)).not.toBe(dados.model.value);
  });

  it('com o driver desligado, ou fora do registro, não há o que conferir', () => {
    expect(
      modeloDaTela({ driver: valor('off'), model: valor('voyage-4'), driverOptions: DRIVERS }),
    ).toBe('voyage-4');
    expect(
      modeloDaTela({ driver: valor('pinecone'), model: valor('x'), driverOptions: DRIVERS }),
    ).toBe('x');
  });
});

describe('o rótulo da chave', () => {
  it('só "presente" afirma que o provedor aceitou a chave', () => {
    // A linha fica logo acima do "Último erro": qualquer outro estado que
    // dissesse "aceita" voltaria a desmentir o erro mostrado embaixo.
    const queAfirmam = Object.entries(ROTULO_DA_CHAVE)
      .filter(([, rotulo]) => /aceita/i.test(rotulo))
      .map(([estado]) => estado);
    expect(queAfirmam).toEqual(['presente']);
  });

  it('conta sem crédito não manda esperar, e o limite de taxa não manda pagar', () => {
    expect(ROTULO_DA_CHAVE['sem-credito']).toMatch(/esperar não resolve/);
    expect(ROTULO_DA_CHAVE['cota-esgotada']).toMatch(/tenta de novo sozinho/);
    expect(ROTULO_DA_CHAVE['nao-confirmada']).toMatch(/último erro/);
  });
});

/**
 * `refusedTexts` está **dentro** de `pendingTexts`, e `stuckSkills` dentro de
 * `staleSkills`: a pendência é real, e o segundo número é a explicação dela. A
 * tela separa os dois — "5 textos a embutir" com 2 recusados prometia um trabalho
 * que o indexador não vai fazer.
 */
describe('as pendências', () => {
  const cobertura = (over: Partial<RagCoverage> = {}): RagCoverage => ({
    texts: 10,
    withVector: 5,
    pendingTexts: 5,
    refusedTexts: 0,
    staleSkills: 3,
    ...over,
  });

  it('sem recusa e sem skill travada, a linha é a de sempre', () => {
    expect(resumoDasPendencias(cobertura())).toBe('3 skill(s) a refatiar, 5 texto(s) a embutir');
  });

  it('o recusado sai da conta do que vai ser embutido, e aparece ao lado', () => {
    expect(pendenciasDe(cobertura({ refusedTexts: 2 }))).toMatchObject({
      aEmbutir: 3,
      recusados: 2,
    });
    expect(resumoDasPendencias(cobertura({ refusedTexts: 2 }))).toBe(
      '3 skill(s) a refatiar, 3 texto(s) a embutir, 2 recusado(s) pelo provedor',
    );
  });

  it('a skill travada sai da conta do que vai ser refatiado, e aparece ao lado', () => {
    expect(pendenciasDe(cobertura({ stuckSkills: 1 }))).toMatchObject({ aRefatiar: 2, travadas: 1 });
    expect(resumoDasPendencias(cobertura({ stuckSkills: 1 }))).toBe(
      '2 skill(s) a refatiar, 1 travada(s), 5 texto(s) a embutir',
    );
  });

  it('servidor que ainda não manda os campos novos não quebra a conta', () => {
    // `stuckSkills` é opcional no tipo do banco; `refusedTexts`, numa resposta em
    // cache de antes da atualização, pode faltar.
    const antiga = { texts: 4, withVector: 1, pendingTexts: 3, staleSkills: 2 } as RagCoverage;
    expect(pendenciasDe(antiga)).toEqual({ aRefatiar: 2, travadas: 0, aEmbutir: 3, recusados: 0 });
  });

  it('número incoerente não vira pendência negativa', () => {
    expect(pendenciasDe(cobertura({ pendingTexts: 1, refusedTexts: 4 })).aEmbutir).toBe(0);
  });
});
