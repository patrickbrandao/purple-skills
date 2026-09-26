import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Library, Pencil, Server, X } from 'lucide-react';
import {
  canEdit,
  getCatalogs,
  plural,
  setQuarantineTargets,
  type CatalogSummary,
  type QuarantineSheet,
  type SkillLinkInput,
} from '../api.js';
import { Badge, Button, EmptyRow, Panel, Skel } from './ui.js';
import { FlagBadges, PublishInPicker } from './SkillMcps.js';
import { useToast } from './Toast.js';

/**
 * O **destino** de um envio da quarentena (`docs/15-quarentena.md` §11): os
 * catálogos em que a skill entra e os servidores em que ela é publicada quando
 * o envio for aprovado. Nada disso é vínculo ainda — até a aprovação, o envio
 * não aparece em catálogo nem servidor nenhum.
 */

/** Os catálogos em que a sessão pode pôr skill: os que ela **edita** (`docs/12` §3.2). */
function useEditableCatalogs() {
  const toast = useToast();
  const [catalogs, setCatalogs] = useState<CatalogSummary[] | null>(null);

  useEffect(() => {
    getCatalogs()
      .then((data) => setCatalogs(data.items.filter((catalog) => canEdit(catalog.access))))
      .catch((err) => {
        toast.error((err as Error).message);
        setCatalogs([]);
      });
  }, [toast]);

  return catalogs;
}

const estadoDoCatalogo = (catalog: CatalogSummary) =>
  [
    catalog.isActive ? null : 'desligado',
    catalog.isPublic ? 'público' : null,
    catalog.mcpCount > 0 ? plural(catalog.mcpCount, 'servidor', 'servidores') : 'sem servidor',
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * "Entrar nos catálogos": controlado, pelo slug, sem chamar a API. O catálogo
 * sem servidor aparece assim mesmo — pôr a skill nele é agrupar, e publicar
 * vem quando o catálogo for vinculado.
 */
export function CatalogPicker({
  value,
  onChange,
  hint,
}: {
  value: string[];
  onChange: (slugs: string[]) => void;
  hint?: ReactNode;
}) {
  const catalogs = useEditableCatalogs();
  const marcados = new Set(value);

  function toggle(slug: string, on: boolean) {
    onChange(on ? [...value, slug] : value.filter((item) => item !== slug));
  }

  return (
    <div className="mt-5">
      <span className="label">Entrar nos catálogos</span>
      <p className="panel-hint">
        {hint ??
          'Ao aprovar, a skill entra nestes catálogos e sai em todo servidor MCP vinculado a eles, com as portas de cada vínculo.'}
      </p>
      {catalogs === null && <Skel h={48} />}
      {catalogs !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th />
                <th>Catálogo</th>
              </tr>
            </thead>
            <tbody>
              {catalogs.map((catalog) => {
                const on = marcados.has(catalog.slug);
                return (
                  <tr key={catalog.uuid} className={catalog.isActive ? undefined : 'is-off'}>
                    <td className="num" style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(event) => toggle(catalog.slug, event.target.checked)}
                        aria-label={`Pôr no catálogo ${catalog.name}`}
                      />
                    </td>
                    <td>
                      <span className="row-title">{catalog.name}</span>
                      <span className="row-sub">
                        {catalog.slug} · {estadoDoCatalogo(catalog)}
                      </span>
                      {/* O catálogo público lista os membros no site, inclusive
                          a skill privada (`docs/12` decisões 4 e 5). */}
                      {on && catalog.isPublic && (
                        <span className="hint" style={{ color: 'var(--warn)' }}>
                          Catálogo público: a skill nasce privada, mas o site a lista entre os membros dele.
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {catalogs.length === 0 && (
                <EmptyRow colSpan={2}>
                  Você não edita nenhum catálogo. <Link to="/catalogs" className="link">Crie um</Link>, ou peça a quem
                  o administra.
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** O texto de "Publicar em" quando quem publica é a aprovação, não o formulário. */
export const HINT_SERVIDORES_NA_QUARENTENA =
  'Ao aprovar, a skill é publicada nestes servidores com as portas marcadas — um vínculo direto, que vale ' +
  'sobre o que um catálogo entrega no mesmo servidor. Sem nenhum marcado e sem catálogo, ela nasce sem vínculo.';

/**
 * O destino na ficha do envio: o que está escolhido, os avisos que travam a
 * aprovação e a edição.
 *
 * Quem enxerga o envio edita o destino, mas **acrescentar** cobra `edit` no
 * catálogo ou servidor. Por isso os seletores só mostram o que a sessão edita,
 * e o destino que ela só enxerga fica numa lista à parte, onde dá para tirar e
 * não para mudar. O que ela nem enxerga aparece como número, com o botão que
 * o tira sem dizer o que era.
 */
export function QuarantineTargetsPanel({
  item,
  onChange,
  disabled,
}: {
  item: QuarantineSheet;
  onChange: (sheet: QuarantineSheet) => void;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [mcps, setMcps] = useState<SkillLinkInput[]>([]);
  // O destino que a sessão enxerga mas não edita: fica, a menos que ela o tire.
  const [tirados, setTirados] = useState<Set<string>>(new Set());
  const [salvando, setSalvando] = useState(false);

  const { targets, hiddenTargetCount } = item;
  const soLeitura = [
    ...targets.catalogs.filter((c) => !c.editable).map((c) => ({ key: `c:${c.slug}`, tipo: 'catálogo', name: c.name })),
    ...targets.mcps.filter((m) => !m.editable).map((m) => ({ key: `m:${m.slug}`, tipo: 'servidor', name: m.name })),
  ];
  const vazio = targets.catalogs.length === 0 && targets.mcps.length === 0 && hiddenTargetCount === 0;

  function editar() {
    setCatalogs(targets.catalogs.filter((c) => c.editable).map((c) => c.slug));
    setMcps(
      targets.mcps
        .filter((m) => m.editable)
        .map((m) => ({ slug: m.slug, asSkill: m.asSkill, asPrompt: m.asPrompt, asResource: m.asResource })),
    );
    setTirados(new Set());
    setEditando(true);
  }

  async function gravar(dropHidden: boolean, pedido?: { catalogs: string[]; mcps: SkillLinkInput[] }) {
    // Sem pedido é o botão dos escondidos: o que a sessão vê fica como está.
    const destino = pedido ?? {
      catalogs: targets.catalogs.map((c) => c.slug),
      mcps: targets.mcps.map((m) => ({ slug: m.slug, asSkill: m.asSkill, asPrompt: m.asPrompt, asResource: m.asResource })),
    };
    setSalvando(true);
    try {
      onChange(await setQuarantineTargets(item.uuid, { ...destino, dropHidden }));
      setEditando(false);
      toast.success('Destino do envio salvo.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  function salvar() {
    const mantidos = {
      catalogs: targets.catalogs.filter((c) => !c.editable && !tirados.has(`c:${c.slug}`)).map((c) => c.slug),
      mcps: targets.mcps
        .filter((m) => !m.editable && !tirados.has(`m:${m.slug}`))
        .map((m) => ({ slug: m.slug, asSkill: m.asSkill, asPrompt: m.asPrompt, asResource: m.asResource })),
    };
    void gravar(false, { catalogs: [...catalogs, ...mantidos.catalogs], mcps: [...mcps, ...mantidos.mcps] });
  }

  return (
    <Panel
      className="mt-4"
      title="Ao aprovar"
      icon={<Library />}
      actions={
        !editando && (
          <Button variant="quiet" size="sm" onClick={editar} disabled={disabled}>
            <Pencil /> Editar destino
          </Button>
        )
      }
    >
      {!editando && (
        <>
          {vazio && (
            <p className="panel-hint mb-0">
              Sem destino: a skill nasce sem catálogo nem servidor, visível só aqui no painel, e é publicada depois, na
              página dela.
            </p>
          )}
          {targets.catalogs.length > 0 && (
            <div className="mb-3">
              <span className="label">Entra nos catálogos</span>
              <div className="flex flex-wrap gap-2">
                {targets.catalogs.map((catalog) => (
                  <Badge key={catalog.uuid} tone="outline">
                    <Library size={12} /> {catalog.name}
                    {!catalog.isActive && ' · desligado'}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {targets.mcps.length > 0 && (
            <div className="mb-3">
              <span className="label">É publicada nos servidores</span>
              <ul className="flex flex-col gap-1">
                {targets.mcps.map((mcp) => (
                  <li key={mcp.uuid} className="flex flex-wrap items-center gap-2">
                    <Server size={14} />
                    <span className="row-title">{mcp.name}</span>
                    <span className="row-sub mono">/virtual/{mcp.slug}</span>
                    {!mcp.isActive && <span className="row-sub">· desligado</span>}
                    <FlagBadges value={mcp} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {soLeitura.length > 0 && (
            <p className="panel-hint" style={{ color: 'var(--warn)' }}>
              <AlertTriangle size={14} /> Você não edita{' '}
              {soLeitura.map((alvo, index) => (
                <span key={alvo.key}>
                  {index > 0 && ', '}o {alvo.tipo} "{alvo.name}"
                </span>
              ))}
              : aprovar com esse destino fica com quem o edita. Dá para tirá-lo em "Editar destino".
            </p>
          )}
          {hiddenTargetCount > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="panel-hint mb-0" style={{ color: 'var(--warn)' }}>
                <AlertTriangle size={14} />{' '}
                {plural(hiddenTargetCount, 'destino a que você não tem acesso', 'destinos a que você não tem acesso')}{' '}
                — só quem tem acesso aprova o envio com {hiddenTargetCount === 1 ? 'ele' : 'eles'}.
              </p>
              <Button variant="quiet" size="sm" onClick={() => void gravar(true)} disabled={disabled || salvando}>
                <X /> Remover {hiddenTargetCount === 1 ? 'esse destino' : 'esses destinos'}
              </Button>
            </div>
          )}
        </>
      )}

      {editando && (
        <>
          <CatalogPicker value={catalogs} onChange={setCatalogs} />
          <PublishInPicker
            value={mcps}
            onChange={setMcps}
            label="Publicar ao aprovar em"
            hint={HINT_SERVIDORES_NA_QUARENTENA}
          />
          {soLeitura.length > 0 && (
            <div className="mt-5">
              <span className="label">Destino que você não edita</span>
              <p className="panel-hint">Dá para tirar do envio; para pôr de volta, só quem o edita.</p>
              <ul className="flex flex-col gap-1">
                {soLeitura.map((alvo) => (
                  <li key={alvo.key}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!tirados.has(alvo.key)}
                        disabled={tirados.has(alvo.key)}
                        onChange={() => setTirados((atual) => new Set(atual).add(alvo.key))}
                      />
                      {alvo.tipo} "{alvo.name}"
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditando(false)} disabled={salvando}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={salvando}>
              {salvando ? 'Salvando…' : 'Salvar destino'}
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
