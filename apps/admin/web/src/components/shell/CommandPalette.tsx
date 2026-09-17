import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { ArrowLeft, BookOpenCheck, Library, Server } from 'lucide-react';
import { getCatalogs, getMcps, listSkills, type CatalogSummary, type SkillSummary, type VirtualMcpSummary } from '../../api.js';
import { GROUP_ORDER, fuzzyScore, useCommandRegistry, type Command as Cmd } from '../commands.js';
import { SkillIcon } from '../SkillIcon.js';
import { Kbd, useDebounced } from '../ui.js';

/**
 * A paleta (⌘K): busca servidores, catálogos e skills e lista os comandos
 * registrados pela tela atual. Tem duas páginas de escolha — "escolher
 * skill" e "escolher catálogo" — usadas pelo canvas e pela página do catálogo
 * para acrescentar um item. A filtragem é nossa (`fuzzyScore`) porque parte
 * dos itens vem do servidor já filtrada.
 */
export function CommandPalette() {
  const { commands, request, close } = useCommandRegistry();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 200);
  const [mcps, setMcps] = useState<VirtualMcpSummary[] | null>(null);
  const [catalogs, setCatalogs] = useState<CatalogSummary[] | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const open = request !== null;
  const pickingSkill = request?.page === 'pick-skill' ? request : null;
  const pickingCatalog = request?.page === 'pick-catalog' ? request : null;
  const picking = pickingSkill ?? pickingCatalog;

  // Limpa ao fechar; carrega servidores e catálogos ao abrir a raiz, e os
  // catálogos (que a sessão administra) na página de escolha deles.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setSkills([]);
      return;
    }
    if (!pickingSkill && mcps === null && !pickingCatalog) {
      getMcps()
        .then((data) => setMcps(data.items))
        .catch(() => setMcps([]));
    }
    if (!pickingSkill && catalogs === null) {
      getCatalogs()
        .then((data) => setCatalogs(data.items))
        .catch(() => setCatalogs([]));
    }
  }, [open, pickingSkill, pickingCatalog, mcps, catalogs]);

  // Skills vêm do servidor: na raiz só com 2+ letras; na página de escolha sempre.
  useEffect(() => {
    if (!open || pickingCatalog) return;
    const q = debounced.trim();
    if (!pickingSkill && q.length < 2) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listSkills({ q, limit: pickingSkill ? 40 : 6, sort: q ? undefined : 'recent' })
      .then((data) => {
        if (!cancelled) setSkills(data.items.filter((skill) => !pickingSkill?.exclude?.has(skill.slug)));
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, pickingSkill, pickingCatalog, debounced]);

  const grouped = useMemo(() => {
    const q = search.trim();
    const scored = commands
      .map((command) => ({ command, score: fuzzyScore(q, `${command.label} ${(command.keywords ?? []).join(' ')}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    const byGroup = new Map<string, Cmd[]>();
    for (const { command } of scored) {
      const list = byGroup.get(command.group) ?? [];
      list.push(command);
      byGroup.set(command.group, list);
    }
    return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({ group, items: byGroup.get(group)! }));
  }, [commands, search]);

  const matchingMcps = useMemo(() => {
    const q = search.trim();
    return (mcps ?? [])
      .map((mcp) => ({ mcp, score: fuzzyScore(q, `${mcp.name} ${mcp.slug}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((entry) => entry.mcp);
  }, [mcps, search]);

  // Na página de escolha a lista inteira vale (menos os já vinculados); na
  // raiz, só quando a busca casa, para não empurrar os comandos para baixo.
  const matchingCatalogs = useMemo(() => {
    const q = search.trim();
    const list = (catalogs ?? []).filter((catalog) => !pickingCatalog?.exclude?.has(catalog.slug));
    if (!pickingCatalog && q.length < 2) return [];
    return list
      .map((catalog) => ({ catalog, score: fuzzyScore(q, `${catalog.name} ${catalog.slug}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, pickingCatalog ? 40 : 6)
      .map((entry) => entry.catalog);
  }, [catalogs, search, pickingCatalog]);

  function run(action: () => void | Promise<void>) {
    close();
    void action();
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      label={picking ? picking.title : 'Paleta de comandos'}
      shouldFilter={false}
      loop
      overlayClassName="overlay"
      contentClassName={`palette${picking ? ' sm' : ''}`}
      onKeyDown={(event) => {
        // Backspace com o campo vazio volta da página de escolha.
        if (picking && event.key === 'Backspace' && !search) {
          event.preventDefault();
          close();
        }
      }}
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder={
          pickingSkill ? 'Buscar skill no catálogo…' : pickingCatalog ? 'Buscar catálogo…' : 'Procurar servidor, catálogo, skill ou comando…'
        }
        autoFocus
      />
      <div className="trail">
        {picking ? (
          <>
            <button type="button" className="row-action" onClick={close} title="Voltar">
              <ArrowLeft />
            </button>
            <span className="crumb">{picking.title}</span>
          </>
        ) : (
          <span>Digite para filtrar</span>
        )}
        <span className="hint-k">
          <span>
            <Kbd>↑↓</Kbd> navegar
          </span>
          <span>
            <Kbd>↵</Kbd> abrir
          </span>
          <span>
            <Kbd>esc</Kbd> fechar
          </span>
        </span>
      </div>
      <Command.List>
        <Command.Empty>
          {loading || (pickingCatalog && catalogs === null)
            ? 'Buscando…'
            : pickingCatalog && (catalogs ?? []).length === 0
              ? 'Você não administra nenhum catálogo.'
              : 'Nada encontrado.'}
        </Command.Empty>

        {pickingSkill && (
          <Command.Group heading="Skills do catálogo">
            {skills.map((skill) => (
              <Command.Item key={skill.uuid} value={`skill:${skill.slug}`} onSelect={() => run(() => pickingSkill.onPick(skill))}>
                <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
                <span className="lbl">{skill.name}</span>
                <span className="sub">
                  {skill.slug}
                  {!skill.isActive ? ' · desligada' : ''}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {pickingCatalog && (
          <Command.Group heading="Catálogos que você administra">
            {matchingCatalogs.map((catalog) => (
              <Command.Item key={catalog.uuid} value={`catalog:${catalog.slug}`} onSelect={() => run(() => pickingCatalog.onPick(catalog))}>
                <Library />
                <span className="lbl">{catalog.name}</span>
                <span className="sub">
                  {catalog.activeSkillCount} skill{catalog.activeSkillCount === 1 ? '' : 's'} ativa{catalog.activeSkillCount === 1 ? '' : 's'}
                  {!catalog.isActive ? ' · desligado' : ''}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {!picking && matchingMcps.length > 0 && (
          <Command.Group heading="Servidores MCP">
            {matchingMcps.map((mcp) => (
              <Command.Item key={mcp.uuid} value={`mcp:${mcp.slug}`} onSelect={() => run(() => navigate(`/mcps/${mcp.slug}`))}>
                <Server />
                <span className="lbl">{mcp.name}</span>
                <span className="sub">
                  /{mcp.slug}
                  {mcp.isDefault ? ' · padrão' : ''}
                  {!mcp.isActive ? ' · desligado' : ''}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {!picking && matchingCatalogs.length > 0 && (
          <Command.Group heading="Catálogos">
            {matchingCatalogs.map((catalog) => (
              <Command.Item key={catalog.uuid} value={`catalog:${catalog.slug}`} onSelect={() => run(() => navigate(`/catalogos/${catalog.slug}`))}>
                <Library />
                <span className="lbl">{catalog.name}</span>
                <span className="sub">
                  {catalog.slug}
                  {!catalog.isActive ? ' · desligado' : ''}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {!picking && skills.length > 0 && (
          <Command.Group heading="Skills">
            {skills.map((skill) => (
              <Command.Item key={skill.uuid} value={`skill:${skill.slug}`} onSelect={() => run(() => navigate(`/skills/${skill.slug}`))}>
                <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
                <span className="lbl">{skill.name}</span>
                <span className="sub">
                  {skill.slug}
                  {!skill.isActive ? ' · desligada' : ''}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {!picking &&
          grouped.map(({ group, items }) => (
            <Command.Group key={group} heading={group}>
              {items.map((command) => (
                <Command.Item
                  key={command.id}
                  value={`cmd:${command.id}`}
                  disabled={Boolean(command.disabled)}
                  className={command.danger ? 'danger' : undefined}
                  onSelect={() => {
                    if (command.disabled) return;
                    run(command.run);
                  }}
                >
                  {command.icon ?? <BookOpenCheck />}
                  <span className="lbl">{command.label}</span>
                  {command.disabled && <span className="sub">{command.disabled}</span>}
                  {command.shortcut && !command.disabled && (
                    <span className="sc">
                      {command.shortcut.split(' ').map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
      </Command.List>
    </Command.Dialog>
  );
}
