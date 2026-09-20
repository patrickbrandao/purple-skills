import { describe, expect, it } from 'vitest';
import {
  QUARANTINE_APPROVERS,
  QUARANTINE_APPROVERS_DEFAULT,
  canEditQuarantine,
  canPromoteQuarantine,
  canViewQuarantine,
  isQuarantineApprovers,
} from './quarantine.js';
import type { Role } from './roles.js';

const DONO = 'u-dono';
const OUTRO = 'u-outro';

describe('política de aprovação da quarentena', () => {
  it('reconhece só as três opções', () => {
    for (const valor of QUARANTINE_APPROVERS) expect(isQuarantineApprovers(valor)).toBe(true);
    expect(isQuarantineApprovers('todos')).toBe(false);
    expect(isQuarantineApprovers('admin+membro')).toBe(false);
    expect(isQuarantineApprovers('')).toBe(false);
    expect(isQuarantineApprovers(undefined)).toBe(false);
    expect(isQuarantineApprovers(null)).toBe(false);
  });

  it('o padrão é o dono aprovar o que é dele', () => {
    expect(QUARANTINE_APPROVERS_DEFAULT).toBe('admin+owner');
  });
});

describe('quem enxerga um envio', () => {
  it('admin e editor veem a fila inteira, inclusive o envio órfão', () => {
    for (const papel of ['admin', 'editor'] as Role[]) {
      expect(canViewQuarantine(papel, OUTRO, DONO)).toBe(true);
      expect(canViewQuarantine(papel, null, DONO)).toBe(true);
    }
  });

  /*
   * Submeter exige `canCreate`, então um membro não cria envio novo. Mas o
   * editor rebaixado a membro continua dono do que trouxe — sumir com o envio
   * dele numa troca de papel seria perder trabalho sem aviso.
   */
  it('o membro vê o que submeteu, e só isso', () => {
    expect(canViewQuarantine('membro', DONO, DONO)).toBe(true);
    expect(canViewQuarantine('membro', OUTRO, DONO)).toBe(false);
    expect(canViewQuarantine('membro', null, DONO)).toBe(false);
  });

  it('sem conta na sessão, ser dono não vale — nulo não casa com nulo', () => {
    expect(canViewQuarantine('membro', null, null)).toBe(false);
  });

  it('editar é o mesmo que enxergar: o espaço não tem concessão por objeto', () => {
    expect(canEditQuarantine).toBe(canViewQuarantine);
  });
});

describe('quem promove', () => {
  it('admin promove nas três políticas', () => {
    for (const política of QUARANTINE_APPROVERS) {
      expect(canPromoteQuarantine(política, 'admin', OUTRO, DONO)).toBe(true);
    }
  });

  it('com "admin", nem o dono nem o editor promovem', () => {
    expect(canPromoteQuarantine('admin', 'editor', DONO, DONO)).toBe(false);
    expect(canPromoteQuarantine('admin', 'editor', OUTRO, DONO)).toBe(false);
  });

  it('com "admin+owner", o dono promove o dele e nada além', () => {
    expect(canPromoteQuarantine('admin+owner', 'editor', DONO, DONO)).toBe(true);
    expect(canPromoteQuarantine('admin+owner', 'editor', OUTRO, DONO)).toBe(false);
  });

  /*
   * Promover **é** criar no acervo, e o papel limita a ação. Era, até a
   * validação de 20/09/2026: o dono rebaixado a membro continuava promovendo o
   * próprio envio — e, dono da skill que nascia, podia publicá-la. A conta que
   * a instalação já decidiu que não cria skill por caminho nenhum criava uma.
   */
  it('quem não pode criar no acervo não promove, nem o próprio envio', () => {
    for (const política of QUARANTINE_APPROVERS) {
      expect(canPromoteQuarantine(política, 'membro', DONO, DONO)).toBe(false);
    }
    // O envio continua sendo dele para ver e corrigir — só o portão fechou.
    expect(canViewQuarantine('membro', DONO, DONO)).toBe(true);
  });

  it('com "admin+editor", o editor promove qualquer envio da fila', () => {
    expect(canPromoteQuarantine('admin+editor', 'editor', OUTRO, DONO)).toBe(true);
    expect(canPromoteQuarantine('admin+editor', 'editor', null, DONO)).toBe(true);
  });

  /*
   * A política amplia o portão, nunca o acesso: quem não enxerga o envio não o
   * promove, em política nenhuma. No app isso já para antes, no 404 do
   * `load` — aqui é a rede de segurança da regra.
   */
  it('não promove o que não enxerga', () => {
    expect(canPromoteQuarantine('admin+owner', 'membro', OUTRO, DONO)).toBe(false);
    expect(canPromoteQuarantine('admin+editor', 'membro', OUTRO, DONO)).toBe(false);
  });
});
