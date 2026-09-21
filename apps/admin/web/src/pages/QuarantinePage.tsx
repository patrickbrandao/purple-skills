import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileArchive, Search, ShieldQuestion, Trash2, Upload } from 'lucide-react';
import {
  canCreate,
  deleteQuarantineItem,
  formatBytes,
  formatRelative,
  getQuarantineList,
  num,
  quarantineDownloadUrl,
  type QuarantineSummary,
  type SessionUser,
} from '../api.js';
import { EmptyRow, Skel, useConfirm, useDebounced } from '../components/ui.js';
import { QUARANTINE_IMPORT_PATH } from '../components/shell/routes.js';
import { useToast } from '../components/Toast.js';

const PAGE = 100;

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
      </div>

      {items === null && <Skel h={220} />}

      {items !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
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
                <tr key={item.uuid}>
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
                    <span className="row-sub">{item.ownerEmail ?? 'sem dono'}</span>
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
                <EmptyRow colSpan={6}>
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
