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
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import {
  assertVector,
  RagAuthError,
  type EmbeddingDriver,
  type EmbeddingModel,
} from './driver.js';
import {
  GEMINI_EMBEDDING_2,
  MODELOS_GOOGLE,
  MODELOS_OPENAI,
  MODELOS_VOYAGE,
} from './models.js';

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

/** Os protocolos que o servidor falso sabe imitar. */
export type ProvedorFalso = 'google' | 'openai' | 'voyage';

/**
 * Erro que o servidor falso pode simular, para testar o mapeamento.
 *
 * Os nomes são **do projeto**, não do provedor: o que interessa ao teste é o
 * que o driver deve fazer com o erro, e é por isso que o mesmo nome vira
 * corpos diferentes em cada API. Nem todo provedor tem todos — `sem-credito`
 * só a OpenAI, `ip-recusado` só a Voyage, `pre-condicao` só o Google.
 */
export type FalhaSimulada =
  | 'chave-invalida-400'
  | 'chave-invalida-401'
  | 'sem-permissao-403'
  | 'ip-recusado'
  | 'sem-credito'
  | 'pre-condicao'
  | 'modelo-inexistente'
  | 'conteudo-recusado'
  | 'limite-de-taxa'
  | 'indisponivel'
  | 'dimensao-errada';

export type ServidorFalsoOptions = {
  /** Qual protocolo imitar. Padrão: `google`. */
  provedor?: ProvedorFalso;
  /**
   * Dimensões devolvidas. Padrão: as do modelo pedido, quando o servidor o
   * conhece; senão, as do modelo padrão do provedor.
   */
  dimensions?: number;
  /** Quando definido, toda requisição falha assim. */
  falha?: FalhaSimulada;
  /** Exige a chave no header do provedor (`x-goog-api-key` ou `Bearer`). */
  exigirChave?: string;
};

export type ServidorFalso = {
  /** URL base para a variável do driver, sem barra final. */
  baseUrl: string;
  /** Tudo que chegou, na ordem, para os testes conferirem o corpo enviado. */
  requisicoes: { caminho: string; corpo: unknown; chave: string | null }[];
  /** Troca a falha simulada no meio do teste. */
  simular: (falha: FalhaSimulada | undefined) => void;
  fechar: () => Promise<void>;
};

type CorpoDeErro = { status: number; body: unknown } | null;

/**
 * Os erros de cada API, no formato que ela usa de verdade.
 *
 * O Google manda `error.status` em maiúsculas; a OpenAI manda `error.type` e
 * `error.code`; a Voyage manda `detail`, no estilo do FastAPI. Um driver que
 * leia o campo errado só falharia contra a API real — que é exatamente o que
 * estes corpos existem para pegar antes.
 */
const CORPOS_DE_ERRO: Record<ProvedorFalso, Partial<Record<FalhaSimulada, CorpoDeErro>>> = {
  google: {
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
    'conteudo-recusado': {
      status: 400,
      body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'input token count exceeds the maximum' } },
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
  },
  openai: {
    'chave-invalida-401': {
      status: 401,
      body: {
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      },
    },
    'sem-permissao-403': {
      status: 403,
      body: {
        error: {
          message: 'Country, region, or territory not supported',
          type: 'invalid_request_error',
          param: null,
          code: 'unsupported_country_region_territory',
        },
      },
    },
    // 429 que **não** é limite de taxa: conta sem crédito. Esperar não resolve.
    'sem-credito': {
      status: 429,
      body: {
        error: {
          message: 'You exceeded your current quota, please check your plan and billing details',
          type: 'insufficient_quota',
          param: null,
          code: 'insufficient_quota',
        },
      },
    },
    'modelo-inexistente': {
      status: 404,
      body: {
        error: {
          message: 'The model does not exist',
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      },
    },
    'conteudo-recusado': {
      status: 400,
      body: {
        error: {
          message: "This model's maximum context length is 8192 tokens",
          type: 'invalid_request_error',
          param: 'input',
          code: 'context_length_exceeded',
        },
      },
    },
    'limite-de-taxa': {
      status: 429,
      body: {
        error: {
          message: 'Rate limit reached for requests',
          type: 'rate_limit_error',
          param: null,
          code: 'rate_limit_exceeded',
        },
      },
    },
    indisponivel: {
      status: 503,
      body: { error: { message: 'The server is overloaded', type: 'server_error', param: null, code: null } },
    },
    'dimensao-errada': null,
  },
  voyage: {
    'chave-invalida-401': { status: 401, body: { detail: 'Provided API key is invalid.' } },
    // Na Voyage o 403 é o IP, não a chave — e a mensagem do driver tem que dizer isso.
    'ip-recusado': { status: 403, body: { detail: 'Forbidden IP address.' } },
    'modelo-inexistente': { status: 404, body: { detail: 'Model not found.' } },
    'conteudo-recusado': {
      status: 400,
      body: { detail: 'The total number of tokens exceeds the limit for this model.' },
    },
    'limite-de-taxa': { status: 429, body: { detail: 'Rate limit exceeded.' } },
    indisponivel: { status: 503, body: { detail: 'Service temporarily unavailable.' } },
    'dimensao-errada': null,
  },
};

/** O modelo padrão de cada protocolo, para as dimensões quando nada diz qual é. */
const MODELOS_POR_PROVEDOR: Record<ProvedorFalso, readonly EmbeddingModel[]> = {
  google: MODELOS_GOOGLE,
  openai: MODELOS_OPENAI,
  voyage: MODELOS_VOYAGE,
};

/** A parte da URL que o driver espera depois do host. */
const SUFIXO_DA_BASE: Record<ProvedorFalso, string> = {
  google: '/v1beta',
  openai: '/v1',
  voyage: '/v1',
};

/**
 * Sobe um servidor HTTP que imita a API de embeddings de um dos três
 * provedores.
 *
 * Com a variável de URL base do driver apontando para ele, o driver **de
 * verdade** roda ponta a ponta sem chave e sem custo: mesmo endereço, mesmo
 * header, mesmo formato de corpo, mesmos erros. É o que permite testar o que a
 * API real não deixaria testar de graça — que o prefixo certo foi aplicado,
 * que o `input_type` certo foi mandado, que cada texto virou um item do lote, e
 * que um vetor de dimensão errada é recusado.
 */
export async function subirServidorFalso(
  options: ServidorFalsoOptions = {},
): Promise<ServidorFalso> {
  const provedor = options.provedor ?? 'google';
  const modelos = MODELOS_POR_PROVEDOR[provedor];
  let falha = options.falha;
  const requisicoes: ServidorFalso['requisicoes'] = [];

  /** As dimensões deste pedido: as do modelo pedido, se o servidor o conhece. */
  const dimensoesDe = (modelo: string | undefined): number => {
    if (options.dimensions !== undefined) return options.dimensions;
    const achado = modelo === undefined ? undefined : modelos.find((m) => m.id === modelo);
    return achado?.dimensions ?? modelos[0]!.dimensions;
  };

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

      const chave = chaveDoHeader(provedor, req.headers);
      const caminho = req.url ?? '';
      requisicoes.push({ caminho, corpo, chave });

      const responder = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (options.exigirChave !== undefined && chave !== options.exigirChave) {
        const erro = CORPOS_DE_ERRO[provedor]['chave-invalida-401'];
        responder(erro?.status ?? 401, erro?.body ?? { detail: 'chave ausente ou errada' });
        return;
      }

      if (falha !== undefined) {
        const erro = CORPOS_DE_ERRO[provedor][falha];
        if (erro) {
          responder(erro.status, erro.body);
          return;
        }
        if (erro === undefined) {
          // O teste pediu uma falha que esta API não tem. Falhar alto é melhor
          // que responder 200 e deixar a asserção passar por engano.
          responder(500, { detail: `o provedor ${provedor} não simula "${falha}"` });
          return;
        }
      }

      // Uma dimensão a menos que a combinada, para o driver recusar.
      const encolher = falha === 'dimensao-errada' ? 1 : 0;

      // ---------------------------------------------------------- google ---
      if (caminho.includes(':batchEmbedContents')) {
        const pedidos =
          (corpo as { requests?: { content?: { parts?: { text?: string }[] } }[] }).requests ?? [];
        const tamanho = dimensoesDe(modeloDoCaminho(caminho)) - encolher;
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
        const tamanho = dimensoesDe(modeloDoCaminho(caminho)) - encolher;
        responder(200, { embedding: { values: vetorFalso(textoDe(parts), tamanho) } });
        return;
      }

      // ------------------------------------------------- openai e voyage ---
      // As duas respondem no mesmo formato (`data[].embedding` com `index` e
      // `usage`); o que as separa é o corpo do pedido e o dos erros.
      if (caminho.endsWith('/embeddings')) {
        const pedido = corpo as {
          model?: string;
          input?: string | string[];
          output_dimension?: number;
        };
        const entradas = Array.isArray(pedido.input)
          ? pedido.input
          : typeof pedido.input === 'string'
            ? [pedido.input]
            : [];
        // A Voyage aceita escolher a dimensão; o servidor a honra, para o teste
        // poder conferir que o driver a mandou.
        const tamanho = (pedido.output_dimension ?? dimensoesDe(pedido.model)) - encolher;

        responder(200, {
          object: 'list',
          data: entradas.map((texto, index) => ({
            object: 'embedding',
            index,
            embedding: vetorFalso(texto, tamanho),
          })),
          model: pedido.model ?? modelos[0]!.id,
          usage: {
            prompt_tokens: entradas.length * 10,
            total_tokens: entradas.length * 10,
          },
        });
        return;
      }

      responder(404, { error: { code: 404, status: 'NOT_FOUND', message: 'caminho desconhecido' }, detail: 'caminho desconhecido' });
    });
  });

  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const endereco = servidor.address();
  if (endereco === null || typeof endereco === 'string') {
    throw new Error('o servidor falso não abriu uma porta TCP');
  }

  return {
    baseUrl: `http://127.0.0.1:${endereco.port}${SUFIXO_DA_BASE[provedor]}`,
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

/** A chave, do header que cada provedor usa. */
function chaveDoHeader(provedor: ProvedorFalso, headers: IncomingHttpHeaders): string | null {
  if (provedor === 'google') return (headers['x-goog-api-key'] as string | undefined) ?? null;
  const bruto = (headers.authorization as string | undefined) ?? '';
  return bruto.startsWith('Bearer ') ? bruto.slice('Bearer '.length) : null;
}

/** `/v1beta/models/<modelo>:método` → `<modelo>`. */
function modeloDoCaminho(caminho: string): string | undefined {
  return /\/models\/([^:]+):/.exec(caminho)?.[1];
}

function textoDe(parts: { text?: string }[] | undefined): string {
  return (parts ?? []).map((p) => p.text ?? '').join('\n');
}

/** Reexportado para quem precisar montar a asserção do vetor. */
export { assertVector, RagAuthError };
