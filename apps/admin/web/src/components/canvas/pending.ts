import type { LinkFlags } from '../../api.js';
import { PORTS, flagsToPorts, sameTarget, type Port, type Target } from './types.js';

/*
 * As escritas de vínculo em andamento no palco. Sem React e sem DOM, para o
 * teste rodar em node: é daqui que saem o que as arestas desenham e o que o
 * próximo gesto grava — as duas contas têm de ser a mesma (`tasks/053`).
 */

/**
 * Uma mudança de porta que já saiu da mão de quem usa e ainda não voltou em
 * `detail`. A marca entra no gesto e só sai depois de o detalhe do servidor
 * ser recarregado (ou de a escrita falhar).
 */
export type Pending = { target: Target; port: Port; kind: 'add' | 'remove' };

/**
 * As portas que valem AGORA para um alvo: as gravadas (`flags`, do último
 * `detail`) mais as marcas em andamento, na ordem dos gestos.
 *
 * O `PUT` do vínculo substitui as três flags de uma vez. Quem monta o conjunto
 * só a partir de `flags` religa a porta que o gesto anterior acabou de
 * desligar — e, pelas caixas da gaveta, chega a perguntar "era a última
 * porta?" quando não era.
 */
export function effectivePorts(flags: LinkFlags, pending: readonly Pending[], target: Target): Port[] {
  const ports = new Set(flagsToPorts(flags));
  for (const change of pending) {
    if (!sameTarget(change.target, target)) continue;
    if (change.kind === 'add') ports.add(change.port);
    else ports.delete(change.port);
  }
  return PORTS.filter((port) => ports.has(port));
}

/**
 * O conjunto que o gesto manda gravar, a partir das portas que valem agora;
 * `null` quando a porta já está como pedido. Vazio = era a última: quem chama
 * confirma e desvincula.
 */
export function nextPorts(current: readonly Port[], port: Port, on: boolean): Port[] | null {
  if (on === current.includes(port)) return null;
  return on ? [...current, port] : current.filter((entry) => entry !== port);
}

/** Há escrita em andamento para este alvo? */
export const hasPending = (pending: readonly Pending[], target: Target): boolean =>
  pending.some((change) => sameTarget(change.target, target));

/** As marcas de quem sai do servidor: o `DELETE` do vínculo desliga as três portas. */
export const unlinkMarks = (target: Target): Pending[] => PORTS.map((port) => ({ target, port, kind: 'remove' }));

/**
 * Uma escrita por vez, na ordem dos gestos.
 *
 * Cada trabalho é a escrita **e** a recarga do detalhe que vem depois dela.
 * Duas requisições soltas chegam ao servidor em qualquer ordem: o `PUT` de uma
 * porta atrás do `DELETE` do mesmo vínculo recria o que acabou de sair, e a
 * recarga mais velha, chegando por último, devolve à tela um estado que já não
 * existe. Em fila, cada recarga enxerga tudo o que esta aba já gravou.
 */
export function createWriteQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job);
    // A falha de um trabalho é de quem o pediu; a fila segue.
    tail = run.catch(() => undefined);
    return run;
  };
}
