/**
 * O endereço de um texto canônico (`docs/14-rag.md` §5.2).
 *
 * SHA-256 sobre os bytes UTF-8 do **texto canônico** — o texto como o projeto
 * o monta, sem o prefixo do driver. A especificação anterior falava do "texto
 * exato enviado ao modelo"; com o Google o texto enviado leva o prefixo do
 * espaço, e o hash mudaria de um espaço para outro, quebrando justamente o
 * compartilhamento que a tabela `rag_texts` existe para ter.
 *
 * Sem normalização nenhuma: para um arquivo curto, que vai inteiro, o hash do
 * texto canônico é o hash do arquivo, e os dois lados batem sem combinação
 * prévia. O banco recalcula o mesmo hash no CHECK de `rag_texts`, então um
 * texto nunca fica guardado sob o hash de outro.
 */
import { createHash } from 'node:crypto';

/** SHA-256 dos bytes UTF-8 do texto, como `Buffer` de 32 bytes. */
export function textSha256(text: string): Buffer {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
}

/** O mesmo hash em hexadecimal minúsculo, para log e comparação em teste. */
export function textSha256Hex(text: string): string {
  return textSha256(text).toString('hex');
}
