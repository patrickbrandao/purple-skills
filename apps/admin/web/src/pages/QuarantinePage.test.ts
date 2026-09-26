import { describe, expect, it } from 'vitest';
import type { QuarantineSummary } from '../api.js';
import { resumoDoLote, type Falha } from './QuarantinePage.js';

const envio = (name: string): QuarantineSummary => ({
  uuid: `uuid-${name}`,
  name,
  description: '',
  sourceFilename: `${name}.zip`,
  ownerUserUuid: null,
  ownerUsername: null,
  fileCount: 1,
  sizeBytes: 10,
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T10:00:00.000Z',
});

const falha = (name: string, message: string): Falha => ({ item: envio(name), message });

/**
 * O aviso de uma ação em lote na fila da quarentena: um aviso só para o lote
 * inteiro, com o primeiro motivo de falha, e os outros envios que falharam
 * ficando marcados na tabela.
 */
describe('resumoDoLote', () => {
  it('tudo certo: só a contagem, no singular ou no plural', () => {
    expect(resumoDoLote(1, [], 'aprovado')).toBe('1 envio aprovado.');
    expect(resumoDoLote(3, [], 'descartado')).toBe('3 envios descartados.');
  });

  it('com falha, o primeiro motivo vem com o nome do envio e diz que ele continua marcado', () => {
    expect(resumoDoLote(2, [falha('torto', 'não tem SKILL.md')], 'aprovado')).toBe(
      '2 envios aprovados. "torto": não tem SKILL.md (continua marcado)',
    );
  });

  it('com várias falhas, conta as outras em vez de listá-las', () => {
    const texto = resumoDoLote(0, [falha('a', 'sem acesso'), falha('b', 'x'), falha('c', 'y')], 'aprovado');

    expect(texto).toBe('"a": sem acesso (e mais 2; continuam marcados)');
  });
});
