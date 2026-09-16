/**
 * A perna semântica da busca deste servidor (`tmp/RAG-GOOGLE.md` §8.1, futuro
 * `docs/14`).
 *
 * O resolvedor é **um por processo**, não um por vMCP: o que ele guarda é a
 * configuração da instalação (`rag.driver`, `rag.model`) e o espaço ativo, que
 * são os mesmos para todos os servidores virtuais. O recorte de visibilidade
 * continua por escopo, dentro da consulta.
 *
 * Nada aqui lança. Sem chave, com o driver `off`, sem a migration, sem espaço
 * ou com o Google fora do ar, a busca responde `mode: 'text'` — a mesma de
 * antes do RAG.
 */
import { findRagSpace, getRagSettings, ragSchemaReady } from '@purple-skills/db';
import { criarBuscaSemantica, criarDriver } from '@purple-skills/rag';
import { config } from './config.js';

/**
 * O driver do ambiente. `null` sem chave — e aí a busca é textual, sem que
 * isso apareça como erro para o cliente.
 */
const driver = criarDriver({
  // O `off` do banco é conferido a cada busca, com cache curto; aqui só se
  // resolve *como* falar com o provedor, caso ele seja usado.
  driver: 'google',
  apiKey: config.rag.apiKey,
  baseUrl: config.rag.baseUrl,
});

export const buscaSemantica = criarBuscaSemantica({
  ports: { ragSchemaReady, getRagSettings, findRagSpace },
  driver,
  timeoutMs: config.rag.queryTimeoutMs,
  log: (mensagem) => console.log(`[mcp-public] ${mensagem}`),
});

/** Para o boot dizer, uma vez, o que o operador precisa saber. */
export function avisoDeBoot(): string | null {
  if (driver === null) {
    return '[mcp-public] RAG_GOOGLE_API_KEY ausente: a busca responde em modo textual';
  }
  return null;
}
