/**
 * O que o `tools/list` do MCP administrativo anuncia — o texto que o agente lê
 * antes de chamar qualquer tool.
 *
 * Os handlers não rodam aqui: `tools/list` só lê o registro. O banco é um mock
 * vazio, e qualquer tool que o tocasse quebraria o teste em vez de passar.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@purple-skills/db', () => ({}));

const { createMcpServer } = await import('./server.js');

async function listarTools() {
  const servidor = createMcpServer();
  const cliente = new Client({ name: 'teste', version: '0.0.0' });
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  await Promise.all([servidor.connect(doServidor), cliente.connect(doCliente)]);
  try {
    return (await cliente.listTools()).tools;
  } finally {
    await cliente.close();
  }
}

describe('tools/list', () => {
  it('a URI do resource anunciada é a do SKILL.md, nunca a revogada', async () => {
    // Relatório 021 da auditoria de 2026-11-07: o `asResource` de quatro tools
    // dizia `skill://<slug>`, que desde a decisão 5 do docs/17 é o diretório da
    // skill — `resources/read` nele responde "não encontrado".
    const tools = await listarTools();
    const textos = JSON.stringify(tools);
    const uris = textos.match(/skill:\/\/[^\s"'`]*/g) ?? [];

    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) expect(uri).toMatch(/^skill:\/\/<slug>\/SKILL\.md/);
  });
});
