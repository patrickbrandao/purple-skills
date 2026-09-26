import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileArchive, Search, ShieldCheck, ShieldQuestion, Trash2, Upload, X } from 'lucide-react';
import {
  atUser,
  canCreate,
  deleteQuarantineItem,
  plural,
  promoteQuarantineItem,
  formatBytes,
  formatRelative,
  getQuarantineList,
  num,
  quarantineDownloadUrl,
  type QuarantineSummary,
  type SessionUser,
} from '../api.js';
import { Button, EmptyRow, Skel, useConfirm, useDebounced } from '../components/ui.js';
import { QUARANTINE_IMPORT_PATH } from '../components/shell/routes.js';
import { useToast } from '../components/Toast.js';

const PAGE = 100;

/** O que um lote deixou para trás: o envio e o motivo que o servidor deu. */
export type Falha = { item: QuarantineSummary; message: string };

/**
 * O resumo de um lote num aviso só: quantos deram certo e, dos que não deram,
 * o primeiro motivo — os outros ficam marcados na tabela, para a pessoa abrir
 * um a um. Os motivos variam (política de aprovação, destino sem acesso,
 * SKILL.md que falta), e listar todos num aviso que some em segundos não
 * ajudaria ninguém.
 */
export function resumoDoLote(feitos: number, falhas: readonly Falha[], verbo: string): string {
  const ok = feitos > 0 ? `${plural(feitos, `envio ${verbo}`, `envios ${verbo}s`)}. ` : '';
  const [primeira] = falhas;
  if (!primeira) return ok.trim();
  const resto = falhas.length > 1 ? ` (e mais ${falhas.length - 1}; continuam marcados)` : ' (continua marcado)';
  return `${ok}"${primeira.item.name}": ${primeira.message}${resto}`;
}

/**
 * A fila da quarentena (`docs/15-quarentena.md`): pacotes importados que
 * esperam aprovação.
 *
 * Um envio **não** é uma skill: não tem slug, tag, vínculo nem contador, não
 * entra na busca do site e não é fatiado pelo RAG. Por isso esta tela não
 * reaproveita a lista de skills — mostrar as mesmas colunas sugeriria que as
 * mesmas coisas existem aqui.
 *
 * Também não há colisão de nome: dois envios do mesmo pacote convivem, e é o
 * arquivo de origem e a data que os distinguem na tela.
 */
export function QuarantinePage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<QuarantineSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const dq = useDebounced(query, 300);
  const podeImportar = canCreate(user.role);
  // Aprovar exige o papel de criar (`docs/15` decisão 18); sem ele, o botão do
  // lote só renderia uma fila de 403.
  const podeAprovar = canCreate(user.role);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [emLote, setEmLote] = useState(false);
  const todos = useRef<HTMLInputElement>(null);

  // Só conta o que está na tela: trocar a busca não deixa marca escondida,
  // que um "Descartar" levaria junto sem a pessoa ver.
  const visiveis = useMemo(() => (items ?? []).filter((item) => marcados.has(item.uuid)), [items, marcados]);
  const tudoMarcado = items !== null && items.length > 0 && visiveis.length === items.length;
  const algumMarcado = visiveis.length > 0 && !tudoMarcado;

  useEffect(() => {
    if (todos.current) todos.current.indeterminate = algumMarcado;
  }, [algumMarcado]);

  useEffect(() => {
    let active = true;
    getQuarantineList(dq, PAGE, 0)
      .then((data) => {
        if (!active) return;
        setItems(data.items);
        setTotal(data.total);
      })
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        setItems((current) => current ?? []);
      });
    return () => {
      active = false;
    };
  }, [dq, toast]);

  function marcar(uuid: string, on: boolean) {
    setMarcados((atual) => {
      const novo = new Set(atual);
      if (on) novo.add(uuid);
      else novo.delete(uuid);
      return novo;
    });
  }

  function marcarTodos(on: boolean) {
    setMarcados(on ? new Set((items ?? []).map((item) => item.uuid)) : new Set());
  }

  /**
   * Um envio de cada vez, pelas mesmas rotas da ficha: cada um passa pela
   * política de aprovação e pela conferência do destino, e cada aprovação é a
   * sua própria transação no banco. Em paralelo, quarenta aprovações
   * disputariam as mesmas travas de catálogo e servidor à toa. O que falha fica
   * marcado; o que deu certo sai da fila.
   */
  async function emSequencia(acao: (item: QuarantineSummary) => Promise<unknown>, verbo: string) {
    const alvo = visiveis;
    setEmLote(true);
    const feitos = new Set<string>();
    const falhas: Falha[] = [];
    for (const item of alvo) {
      try {
        await acao(item);
        feitos.add(item.uuid);
      } catch (err) {
        falhas.push({ item, message: (err as Error).message });
      }
    }
    setItems((atual) => (atual ?? []).filter((linha) => !feitos.has(linha.uuid)));
    setTotal((atual) => atual - feitos.size);
    setMarcados(new Set(falhas.map((falha) => falha.item.uuid)));
    setEmLote(false);

    const texto = resumoDoLote(feitos.size, falhas, verbo);
    if (falhas.length > 0) toast.error(texto);
    else toast.success(texto);
  }

  /** Sem diálogo, como o "Aprovar" da ficha: o clique já é a decisão. */
  function aprovarMarcados() {
    void emSequencia((item) => promoteQuarantineItem(item.uuid), 'aprovado');
  }

  /** Descartar apaga, e não tem volta: este pede confirmação. */
  async function descartarMarcados() {
    const n = visiveis.length;
    const ok = await confirm({
      title: n === 1 ? `Descartar o envio "${visiveis[0]!.name}"?` : `Descartar ${plural(n, 'envio', 'envios')}?`,
      description: 'Os arquivos deles somem. Nada foi publicado ainda, então nada mais é afetado.',
      confirmLabel: 'Descartar',
      danger: true,
    });
    if (!ok) return;
    await emSequencia((item) => deleteQuarantineItem(item.uuid), 'descartado');
  }

  async function descartar(item: QuarantineSummary) {
    const ok = await confirm({
      title: `Descartar o envio "${item.name}"?`,
      description: 'Os arquivos dele somem. Nada foi publicado ainda, então nada mais é afetado.',
      confirmLabel: 'Descartar',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteQuarantineItem(item.uuid);
      setItems((current) => (current ?? []).filter((linha) => linha.uuid !== item.uuid));
      setTotal((current) => current - 1);
      marcar(item.uuid, false);
      toast.success(`Envio "${item.name}" descartado.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Quarentena</h1>
          <p className="sub">
            Pacotes importados esperando aprovação. Nada aqui é publicado, indexado nem aparece no site — a skill só
            passa a existir quando o envio é aprovado.
          </p>
        </div>
        <div className="page-actions">
          <label className="search-bar">
            <Search />
            <input
              type="search"
              className="field"
              style={{ minWidth: 240 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Procurar envio"
            />
          </label>
          {podeImportar && (
            <Link to={QUARANTINE_IMPORT_PATH} className="btn btn-primary">
              <Upload /> Importar pacote
            </Link>
          )}
        </div>
      </div>

      <div className="meta-line">
        <span className="stat">
          <ShieldQuestion />
          {items ? `${num(total)} envio${total === 1 ? '' : 's'} na fila` : 'Carregando…'}
        </span>
        {visiveis.length > 0 && (
          <>
            <span className="sep" />
            <span className="stat">{plural(visiveis.length, 'marcado', 'marcados')}</span>
            <span className="flex flex-wrap items-center gap-2" style={{ marginLeft: 'auto' }}>
              <Button variant="ghost" size="sm" onClick={() => marcarTodos(false)} disabled={emLote}>
                <X /> Desmarcar
              </Button>
              <Button variant="danger" size="sm" onClick={() => void descartarMarcados()} disabled={emLote}>
                <Trash2 /> Descartar
              </Button>
              {podeAprovar && (
                <Button size="sm" onClick={aprovarMarcados} disabled={emLote}>
                  <ShieldCheck /> {emLote ? 'Processando…' : 'Aprovar'}
                </Button>
              )}
            </span>
          </>
        )}
      </div>

      {items === null && <Skel h={220} />}

      {items !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="num" style={{ width: 36 }}>
                  <input
                    ref={todos}
                    type="checkbox"
                    checked={tudoMarcado}
                    onChange={(event) => marcarTodos(event.target.checked)}
                    disabled={emLote || items.length === 0}
                    aria-label="Marcar todos os envios da lista"
                  />
                </th>
                <th>Envio</th>
                <th className="hidden md:table-cell">Enviado por</th>
                <th className="num hidden sm:table-cell">Arquivos</th>
                <th className="num hidden sm:table-cell">Tamanho</th>
                <th className="hidden lg:table-cell">Recebido</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.uuid} className={marcados.has(item.uuid) ? 'is-selected' : undefined}>
                  <td className="num" style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={marcados.has(item.uuid)}
                      onChange={(event) => marcar(item.uuid, event.target.checked)}
                      disabled={emLote}
                      aria-label={`Marcar o envio ${item.name}`}
                    />
                  </td>
                  <td>
                    <Link to={`/quarantine/${item.uuid}`} className="flex items-center gap-3 no-underline">
                      <span className="skill-icon sm" aria-hidden="true">
                        <FileArchive size={14} />
                      </span>
                      <span className="min-w-0">
                        <span className="row-title">{item.name}</span>
                        <span className="row-sub mono">{item.sourceFilename ?? 'pacote sem nome'}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="hidden md:table-cell">
                    <span className="row-sub">{atUser(item.ownerUsername, 'sem dono')}</span>
                  </td>
                  <td className="num hidden sm:table-cell">{num(item.fileCount)}</td>
                  <td className="num hidden sm:table-cell">{formatBytes(item.sizeBytes)}</td>
                  <td className="hidden lg:table-cell">
                    <span className="row-sub">{formatRelative(item.createdAt)}</span>
                  </td>
                  <td className="num">
                    <span className="flex justify-end gap-1">
                      <a
                        href={quarantineDownloadUrl(item.uuid)}
                        className="row-action"
                        download
                        title="Baixar o pacote como está"
                      >
                        <Download />
                      </a>
                      <button
                        type="button"
                        className="row-action danger"
                        onClick={() => void descartar(item)}
                        title="Descartar envio"
                      >
                        <Trash2 />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <EmptyRow colSpan={7}>
                  {query ? 'Nenhum envio encontrado' : 'A quarentena está vazia'}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}

      {items !== null && total > items.length && (
        <p className="panel-hint mt-4 text-center">
          Mostrando os {num(items.length)} envios mais recentes de {num(total)}. Use a busca para chegar aos demais.
        </p>
      )}

      {items !== null && items.length === 0 && !query && podeImportar && (
        <div className="mt-4 flex justify-center">
          {/* `Link`, não `Button` dentro de `Link`: botão dentro de âncora é
              aninhamento inválido, e o clique do teclado fica ambíguo. */}
          <Link to={QUARANTINE_IMPORT_PATH} className="btn btn-ghost">
            <Upload /> Importar um pacote para a quarentena
          </Link>
        </div>
      )}
    </div>
  );
}
