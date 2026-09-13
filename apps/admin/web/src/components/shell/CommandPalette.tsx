import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { ArrowLeft, Server, Table2 } from 'lucide-react';
import { getMcps, listSkills, type SkillSummary, type VirtualMcpSummary } from '../../api.js';
import { GROUP_ORDER, fuzzyScore, useCommandRegistry, type Command as Cmd } from '../commands.js';
import { SkillIcon } from '../SkillIcon.js';
import { Kbd, useDebounced } from '../ui.js';

/**
 * A paleta (⌘K): busca servidores e skills e lista os comandos registrados
 * pela tela atual. Tem uma segunda página, "escolher skill", usada pelo
 * canvas para acrescentar um nó. A filtragem é nossa (`fuzzyScore`) porque
 * parte dos itens vem do servidor já filtrada.
 */
export function CommandPalette() {
  const { commands, request, close } = useCommandRegistry();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 200);
  const [mcps, setMcps] = useState<VirtualMcpSummary[] | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const open = request !== null;
  const picking = request?.page === 'pick-skill' ? request : null;

  // Limpa ao fechar e carrega os servidores ao abrir a raiz.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setSkills([]);
      return;
    }
    if (!picking && mcps === null) {
      getMcps()
        .then((data) => setMcps(data.items))
        .catch(() => setMcps([]));
    }
  }, [open, picking, mcps]);

  // Skills vêm do servidor: na raiz só com 2+ letras; na página de escolha sempre.
  useEffect(() => {
    if (!open) return;
    const q = debounced.trim();
    if (!picking && q.length < 2) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listSkills({ q, limit: picking ? 40 : 6, sort: q ? undefined : 'recent' })
      .then((data) => {
        if (!cancelled) setSkills(data.items.filter((skill) => !picking?.exclude?.has(skill.slug)));
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
  }, [open, picking, debounced]);

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
        placeholder={picking ? 'Buscar skill no catálogo…' : 'Procurar servidor, skill ou comando…'}
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
        <Command.Empty>{loading ? 'Buscando…' : 'Nada encontrado.'}</Command.Empty>

        {picking && (
          <Command.Group heading="Skills do catálogo">
            {skills.map((skill) => (
              <Command.Item key={skill.uuid} value={`skill:${skill.slug}`} onSelect={() => run(() => picking.onPick(skill))}>
                <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
                <span className="lbl">{skill.name}</span>
                <span className="sub">{skill.slug}</span>
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

        {!picking && skills.length > 0 && (
          <Command.Group heading="Skills">
            {skills.map((skill) => (
              <Command.Item key={skill.uuid} value={`skill:${skill.slug}`} onSelect={() => run(() => navigate(`/skills/${skill.slug}`))}>
                <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
                <span className="lbl">{skill.name}</span>
                <span className="sub">{skill.slug}</span>
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
                  {command.icon ?? <Table2 />}
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
