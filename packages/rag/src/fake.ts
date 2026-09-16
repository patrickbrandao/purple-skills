/**
 * O driver falso e o servidor falso (`tmp/RAG-GOOGLE.md` §6.3).
 *
 * Os dois existem para o fluxo inteiro — indexador, busca, painel — rodar sem
 * chave, sem rede e sem custo, e para os testes conferirem coisas que a API
 * real não deixaria conferir de graça: que o prefixo certo foi aplicado, que
 * cada texto virou um item de `requests[]`, e que um vetor de dimensão errada
 * é recusado.
 *
 * O vetor é determinístico por palavras: o mesmo texto sempre dá o mesmo
 * vetor, e textos com palavras em comum ficam próximos. Não é um modelo — é o
 * suficiente para a fusão da §8.2 ter o que ordenar.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  assertVector,
  RagAuthError,
  type EmbeddingDriver,
  type EmbeddingModel,
} from './driver.js';
import { GEMINI_EMBEDDING_2 } from './google.js';

/** Um modelo pequeno, para teste não carregar 3072 floats a cada asserção. */
export const MODELO_FALSO: EmbeddingModel = {
  id: 'fake-embedding',
  dimensions: 32,
  documentPrefix: 'title: none | text: ',
  queryPrefix: 'task: search result | query: ',
  maxInputTokens: 8192,
  maxBatch: 100,
  maxBatchChars: 60_000,
  maxPartChars: 6000,
};

/** Os prefixos que o servidor falso conhece e remove antes de calcular. */
const PREFIXOS = [
  GEMINI_EMBEDDING_2.documentPrefix,
  GEMINI_EMBEDDING_2.queryPrefix,
  MODELO_FALSO.documentPrefix,
  MODELO_FALSO.queryPrefix,
];

/** Tira o prefixo conhecido, para ele não somar ruído ao vetor. */
export function semPrefixo(texto: string): string {
  for (const prefixo of PREFIXOS) {
    if (texto.startsWith(prefixo)) return texto.slice(prefixo.length);
  }
  return texto;
}

/**
 * Vetor determinístico por palavras, normalizado.
 *
 * Cada palavra cai numa posição pelo hash e soma peso ali. Dois textos que
 * compartilham palavras apontam para a mesma direção; textos sem nada em comum
 * ficam quase ortogonais. É o bastante para a distância do pgvector ordenar.
 */
export function vetorFalso(texto: string, dimensions: number): number[] {
  const valores = new Array<number>(dimensions).fill(0);
  const palavras = semPrefixo(texto)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  for (const palavra of palavras) {
    const digest = createHash('sha256').update(palavra, 'utf8').digest();
    const posicao = digest.readUInt32BE(0) % dimensions;
    // O sinal vem do hash: palavras diferentes não se cancelam por acaso.
    const sinal = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
    valores[posicao] += sinal;
  }

  const norma = Math.sqrt(valores.reduce((acc, v) => acc + v * v, 0));
  if (norma === 0) {
    // Texto sem palavra nenhuma: um vetor fixo, não um vetor de zeros — a
    // distância do cosseno não é definida para o vetor nulo.
    valores[0] = 1;
    return valores;
  }
  return valores.map((v) => v / norma);
}

/** Driver falso, sem rede. */
export class FakeDriver implements EmbeddingDriver {
  readonly id = 'fake' as const;
  readonly models = [MODELO_FALSO] as const;

  /** Tudo que foi pedido, para o teste conferir o prefixo aplicado. */
  readonly recebidos: { metodo: 'documents' | 'query'; textos: string[] }[] = [];

  async embedDocuments(model: EmbeddingModel, texts: readonly string[]): Promise<number[][]> {
    this.recebidos.push({
      metodo: 'documents',
      textos: texts.map((t) => `${model.documentPrefix}${t}`),
    });
    return texts.map((t) => vetorFalso(t, model.dimensions));
  }

  async embedQuery(model: EmbeddingModel, text: string): Promise<number[]> {
    this.recebidos.push({ metodo: 'query', textos: [`${model.queryPrefix}${text}`] });
    return vetorFalso(text, model.dimensions);
  }
}

/** Erro que o servidor falso pode simular, para testar o mapeamento. */
export type FalhaSimulada =
  | 'chave-invalida-400'
  | 'chave-invalida-401'
  | 'sem-permissao-403'
  | 'pre-condicao'
  | 'modelo-inexistente'
  | 'limite-de-taxa'
  | 'indisponivel'
  | 'dimensao-errada';

export type ServidorFalsoOptions = {
  /** Dimensões devolvidas. Padrão: as do `gemini-embedding-2`. */
  dimensions?: number;
  /** Quando definido, toda requisição falha assim. */
  falha?: FalhaSimulada;
  /** Exige a chave no header `x-goog-api-key`. */
  exigirChave?: string;
};

export type ServidorFalso = {
  /** URL base para `RAG_GOOGLE_BASE_URL`, sem barra final. */
  baseUrl: string;
  /** Tudo que chegou, na ordem, para os testes conferirem o corpo enviado. */
  requisicoes: { caminho: string; corpo: unknown; chave: string | null }[];
  /** Troca a falha simulada no meio do teste. */
  simular: (falha: FalhaSimulada | undefined) => void;
  fechar: () => Promise<void>;
};

const CORPOS_DE_ERRO: Record<FalhaSimulada, { status: number; body: unknown } | null> = {
  'chave-invalida-400': {
    status: 400,
    body: {
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] },
    },
  },
  'chave-invalida-401': {
    status: 401,
    body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials' } },
  },
  'sem-permissao-403': {
    status: 403,
    body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'permissão negada' } },
  },
  'pre-condicao': {
    status: 400,
    body: { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'free tier não disponível na sua região' } },
  },
  'modelo-inexistente': {
    status: 404,
    body: { error: { code: 404, status: 'NOT_FOUND', message: 'modelo não encontrado' } },
  },
  'limite-de-taxa': {
    status: 429,
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'cota esgotada' } },
  },
  indisponivel: {
    status: 503,
    body: { error: { code: 503, status: 'UNAVAILABLE', message: 'serviço indisponível' } },
  },
  // Responde 200 com um vetor do tamanho errado: o driver é que recusa.
  'dimensao-errada': null,
};

/**
 * Sobe um servidor HTTP que imita `embedContent` e `batchEmbedContents`.
 *
 * Com `RAG_GOOGLE_BASE_URL` apontando para ele, o driver `google` de verdade
 * roda ponta a ponta sem chave e sem custo.
 */
export async function subirServidorFalso(
  options: ServidorFalsoOptions = {},
): Promise<ServidorFalso> {
  const dimensions = options.dimensions ?? GEMINI_EMBEDDING_2.dimensions;
  let falha = options.falha;
  const requisicoes: ServidorFalso['requisicoes'] = [];

  const servidor: Server = createServer((req, res) => {
    const pedacos: Buffer[] = [];
    req.on('data', (p: Buffer) => pedacos.push(p));
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos).toString('utf8');
      let corpo: unknown = null;
      try {
        corpo = bruto === '' ? null : JSON.parse(bruto);
      } catch {
        corpo = bruto;
      }

      const chave = (req.headers['x-goog-api-key'] as string | undefined) ?? null;
      const caminho = req.url ?? '';
      requisicoes.push({ caminho, corpo, chave });

      const responder = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (options.exigirChave !== undefined && chave !== options.exigirChave) {
        responder(401, {
          error: { code: 401, status: 'UNAUTHENTICATED', message: 'chave ausente ou errada' },
        });
        return;
      }

      if (falha !== undefined) {
        const erro = CORPOS_DE_ERRO[falha];
        if (erro) {
          responder(erro.status, erro.body);
          return;
        }
      }

      // Uma dimensão a menos que a combinada, para o driver recusar.
      const tamanho = falha === 'dimensao-errada' ? dimensions - 1 : dimensions;

      if (caminho.includes(':batchEmbedContents')) {
        const pedidos = (corpo as { requests?: { content?: { parts?: { text?: string }[] } }[] })
          .requests ?? [];
        responder(200, {
          embeddings: pedidos.map((p) => ({
            values: vetorFalso(textoDe(p.content?.parts), tamanho),
          })),
          usageMetadata: { totalTokenCount: pedidos.length * 10 },
        });
        return;
      }

      if (caminho.includes(':embedContent')) {
        const parts = (corpo as { content?: { parts?: { text?: string }[] } }).content?.parts;
        responder(200, { embedding: { values: vetorFalso(textoDe(parts), tamanho) } });
        return;
      }

      responder(404, { error: { code: 404, status: 'NOT_FOUND', message: 'caminho desconhecido' } });
    });
  });

  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const endereco = servidor.address();
  if (endereco === null || typeof endereco === 'string') {
    throw new Error('o servidor falso não abriu uma porta TCP');
  }

  return {
    baseUrl: `http://127.0.0.1:${endereco.port}/v1beta`,
    requisicoes,
    simular: (nova) => {
      falha = nova;
    },
    fechar: () =>
      new Promise<void>((resolve, reject) =>
        servidor.close((erro) => (erro ? reject(erro) : resolve())),
      ),
  };
}

function textoDe(parts: { text?: string }[] | undefined): string {
  return (parts ?? []).map((p) => p.text ?? '').join('\n');
}

/** Reexportado para quem precisar montar a asserção do vetor. */
export { assertVector, RagAuthError };
