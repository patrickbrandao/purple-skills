/**
 * A perna semântica da busca deste servidor (`docs/14-rag.md` §8.1).
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
import { criarBuscaSemantica, criarDriversDoAmbiente, RAG_DRIVERS } from '@purple-skills/rag';
import { config } from './config.js';

/**
 * Os drivers do ambiente, um por chave presente. Qual deles vale é o
 * `rag.driver` do banco, conferido a cada busca com cache curto; aqui só se
 * resolve *como* falar com cada provedor. Sem chave nenhuma, a busca é
 * textual, sem que isso apareça como erro para o cliente.
 */
const drivers = criarDriversDoAmbiente();

export const buscaSemantica = criarBuscaSemantica({
  ports: { ragSchemaReady, getRagSettings, findRagSpace },
  driver: drivers.resolver,
  timeoutMs: config.rag.queryTimeoutMs,
  log: (mensagem) => console.log(`[mcp-public] ${mensagem}`),
});

/** Para o boot dizer, uma vez, o que o operador precisa saber. */
export function avisoDeBoot(): string | null {
  if (drivers.comChave.length === 0) {
    const vars = RAG_DRIVERS.map((d) => d.apiKeyEnv).join(', ');
    return `[mcp-public] nenhuma chave de RAG no ambiente (${vars}): a busca responde em modo textual`;
  }
  return null;
}
