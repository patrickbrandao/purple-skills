import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type IsValidConnection,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type OnBeforeDelete,
  type OnNodesDelete,
} from '@xyflow/react';
import { LayoutTemplate, Maximize, Minus, Plus } from 'lucide-react';
import {
  getMcpOnline,
  linkSkillToMcp,
  setMcpCanvas,
  unlinkSkillFromMcp,
  type CanvasPoint,
  type OnlineCount,
  type SkillSummary,
  type VirtualMcpDetail,
  type VirtualMcpSkill,
} from '../../api.js';
import { usePalette, useRegisterCommands } from '../commands.js';
import { useToast } from '../Toast.js';
import { Button, isTypingTarget, useConfirm, usePolling } from '../ui.js';
import { useTheme } from '../../useTheme.js';
import { nodeTypes } from './nodes.js';
import { edgeTypes } from './edges.js';
import { AddSkillDialog } from './AddSkillDialog.js';
import { NodeDrawer, type Selection } from './NodeDrawer.js';
import { DEFAULT_INTERNET, DEFAULT_SERVER, GRID, autoLayout, freeSlot, placeSkills, snap } from './layout.js';
import {
  INTERNET_ID,
  PORTS,
  SERVER_ID,
  SKILL_HANDLE,
  flagsToPorts,
  portEdgeId,
  portOfHandle,
  portOfSkillHandle,
  portsToFlags,
  skillNodeId,
  slugOfNodeId,
  type CanvasEdge,
  type CanvasNode,
  type Port,
  type PortEdge,
} from './types.js';

type Pending = { slug: string; port: Port; kind: 'add' | 'remove' };

const isSelectedNode = (id: string, selection: Selection): boolean => {
  if (!selection) return false;
  if (selection.kind === 'skill') return slugOfNodeId(id) === selection.slug;
  return id === (selection.kind === 'server' ? SERVER_ID : INTERNET_ID);
};

/**
 * O palco de um servidor: o vMCP com as três portas, as skills vinculadas e o
 * globo da Internet com o contador de clientes online. O estado vem do
 * servidor (`detail`); só a posição dos nós é local, persistida no vMCP.
 *
 * Toda aresta é gravada na hora: conectar liga a porta (`PUT` do vínculo),
 * desconectar desliga — e a última aresta que sai tira a skill do servidor.
 */
export function ServerCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

type CanvasProps = {
  detail: VirtualMcpDetail;
  onDetail: (detail: VirtualMcpDetail) => void;
  canEdit: boolean;
  onlineWindowMs: number;
  onOpenSessions: () => void;
};

function Canvas({ detail, onDetail, canEdit, onlineWindowMs, onOpenSessions }: CanvasProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const { open: openPalette } = usePalette();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [theme] = useTheme();

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [online, setOnline] = useState<OnlineCount | null>(null);
  const [adding, setAdding] = useState<SkillSummary | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const fitted = useRef(false);

  // ---------------------------------------------------------------- online --
  usePolling(async () => {
    try {
      setOnline(await getMcpOnline(detail.slug));
    } catch {
      // o contador é informativo: uma falha não derruba o palco
    }
  }, 5000);

  // ----------------------------------------------------------------- nodes --
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Reconcilia com `detail`: quem já estava é reaproveitado (só `data` muda),
  // quem entrou ganha um vão livre, quem saiu some. Recriar o objeto do nó
  // apagaria `measured` e `dragging`, o React Flow mediria de novo e o arraste
  // em curso cairia — e este efeito roda a cada contagem de online (5 s).
  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]));
      const known = new Map<string, CanvasPoint>();
      for (const node of current) {
        const slug = slugOfNodeId(node.id);
        if (slug) known.set(slug, node.position);
      }
      const positions = placeSkills(detail, known);
      const counts = { tools: detail.toolCount, resources: detail.resourceCount, prompts: detail.promptCount };
      const upsert = <N extends CanvasNode>(fresh: N): N => {
        const prev = previous.get(fresh.id);
        if (prev) return { ...prev, data: fresh.data, deletable: fresh.deletable } as N;
        return { ...fresh, selected: isSelectedNode(fresh.id, selectionRef.current) };
      };

      return [
        upsert({
          id: INTERNET_ID,
          type: 'internet',
          position: detail.layout.internet ?? DEFAULT_INTERNET,
          data: { online: online?.total ?? detail.onlineSessions },
          deletable: false,
        }),
        upsert({
          id: SERVER_ID,
          type: 'server',
          position: detail.layout.server ?? DEFAULT_SERVER,
          data: { name: detail.name, slug: detail.slug, isActive: detail.isActive, isOpen: detail.isOpen, isDefault: detail.isDefault, counts },
          deletable: false,
          zIndex: 2,
        }),
        ...detail.skills.map((skill) =>
          upsert<CanvasNode>({
            id: skillNodeId(skill.slug),
            type: 'skill',
            position: positions.get(skill.slug)!,
            data: { slug: skill.slug, name: skill.name, icon: skill.icon, ports: flagsToPorts(skill), busy: busySlug === skill.slug },
            zIndex: 2,
            deletable: canEdit,
          }),
        ),
      ];
    });
  }, [detail, online?.total, busySlug, canEdit, setNodes]);

  // A seleção da gaveta manda no destaque dos nós, sem tocar no resto.
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const selected = isSelectedNode(node.id, selection);
        return node.selected === selected ? node : { ...node, selected };
      }),
    );
  }, [selection, setNodes]);

  useEffect(() => {
    if (fitted.current || nodes.length === 0) return;
    fitted.current = true;
    // Espera o React Flow medir os nós antes de enquadrar.
    const timer = setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1 }), 50);
    return () => clearTimeout(timer);
  }, [nodes.length, fitView]);

  // ----------------------------------------------------------------- edges --
  const edges = useMemo<CanvasEdge[]>(() => {
    const list: CanvasEdge[] = [
      {
        id: 'traffic',
        type: 'traffic',
        source: INTERNET_ID,
        sourceHandle: 'out',
        target: SERVER_ID,
        targetHandle: 'in',
        className: `edge-traffic${(online?.total ?? detail.onlineSessions) > 0 ? ' live' : ''}`,
        data: { online: online?.total ?? detail.onlineSessions },
        selectable: false,
        deletable: false,
        zIndex: 1,
      },
    ];
    for (const skill of detail.skills) {
      const ports = new Set(flagsToPorts(skill));
      for (const item of pending) {
        if (item.slug !== skill.slug) continue;
        if (item.kind === 'add') ports.add(item.port);
        else ports.delete(item.port);
      }
      for (const port of PORTS) {
        if (!ports.has(port)) continue;
        const saving = pending.some((item) => item.slug === skill.slug && item.port === port);
        list.push({
          id: portEdgeId(port, skill.slug),
          type: 'port',
          source: SERVER_ID,
          sourceHandle: `port-${port}`,
          target: skillNodeId(skill.slug),
          targetHandle: SKILL_HANDLE[port],
          className: `edge-port ${port}${saving ? ' saving' : ''}`,
          data: { port, slug: skill.slug, saving },
          deletable: canEdit && !saving,
          zIndex: 1,
        });
      }
    }
    // Skills recém-adicionadas ainda sem linha em `detail` (pendentes de add)
    for (const item of pending) {
      if (item.kind !== 'add' || detail.skills.some((skill) => skill.slug === item.slug)) continue;
      list.push({
        id: portEdgeId(item.port, item.slug),
        type: 'port',
        source: SERVER_ID,
        sourceHandle: `port-${item.port}`,
        target: skillNodeId(item.slug),
        targetHandle: SKILL_HANDLE[item.port],
        className: `edge-port ${item.port} saving`,
        data: { port: item.port, slug: item.slug, saving: true },
        deletable: false,
        zIndex: 1,
      });
    }
    return list;
  }, [detail, pending, online?.total, canEdit]);

  // ---------------------------------------------------------- persistência --
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<{ positions: Map<string, CanvasPoint>; layout: { server?: CanvasPoint; internet?: CanvasPoint } }>({
    positions: new Map(),
    layout: {},
  });

  const flushPositions = useCallback(() => {
    const queue = saveQueue.current;
    saveQueue.current = { positions: new Map(), layout: {} };
    const positions = [...queue.positions.entries()].map(([slug, point]) => ({ slug, x: point.x, y: point.y }));
    const layout = queue.layout;
    if (positions.length === 0 && !layout.server && !layout.internet) return;
    setMcpCanvas(detail.slug, { positions: positions.length ? positions : undefined, layout: Object.keys(layout).length ? layout : undefined }).catch(
      (err) => toast.error(`Não foi possível salvar as posições: ${(err as Error).message}`),
    );
  }, [detail.slug, toast]);

  const queuePosition = useCallback(
    (node: Node) => {
      const point = { x: snap(node.position.x), y: snap(node.position.y) };
      const slug = slugOfNodeId(node.id);
      if (slug) saveQueue.current.positions.set(slug, point);
      else if (node.id === SERVER_ID) saveQueue.current.layout.server = point;
      else if (node.id === INTERNET_ID) saveQueue.current.layout.internet = point;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flushPositions, 400);
    },
    [flushPositions],
  );

  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        flushPositions();
      }
    },
    [flushPositions],
  );

  // ------------------------------------------------------------- vínculos --
  const runLink = useCallback(
    async (slug: string, ports: Port[], position?: CanvasPoint) => {
      setBusySlug(slug);
      try {
        // A resposta é o detalhe da skill; o do servidor é recarregado por quem nos chamou.
        await linkSkillToMcp(slug, detail.slug, { ...portsToFlags(ports), position });
        return true;
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      } finally {
        setBusySlug(null);
      }
    },
    [detail.slug, toast],
  );

  const runUnlink = useCallback(
    async (slug: string) => {
      setBusySlug(slug);
      try {
        await unlinkSkillFromMcp(slug, detail.slug);
        return true;
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      } finally {
        setBusySlug(null);
      }
    },
    [detail.slug, toast],
  );

  /** Reaplica as portas de uma skill: com nenhuma, desvincula (e o nó some). */
  const applyPorts = useCallback(
    async (skill: VirtualMcpSkill, ports: Port[], change: Pending) => {
      setPending((current) => [...current, change]);
      const ok = ports.length === 0 ? await runUnlink(skill.slug) : await runLink(skill.slug, ports);
      setPending((current) => current.filter((item) => item !== change));
      if (ok) {
        onDetail(await refetch(detail.slug));
        if (ports.length === 0 && selection?.kind === 'skill' && selection.slug === skill.slug) setSelection(null);
      }
    },
    [detail.slug, onDetail, runLink, runUnlink, selection],
  );

  const togglePort = useCallback(
    (skill: VirtualMcpSkill, port: Port, on: boolean) => {
      const current = flagsToPorts(skill);
      if (on === current.includes(port)) return;
      const ports = on ? [...current, port] : current.filter((item) => item !== port);
      if (ports.length === 0) {
        void confirm({
          title: `Tirar "${skill.name}" do servidor?`,
          description: 'Era a última porta. A skill sai deste servidor; ela continua no catálogo e nos outros servidores.',
          confirmLabel: 'Tirar',
          danger: true,
        }).then((ok) => {
          if (ok) void applyPorts(skill, ports, { slug: skill.slug, port, kind: 'remove' });
        });
        return;
      }
      void applyPorts(skill, ports, { slug: skill.slug, port, kind: on ? 'add' : 'remove' });
    },
    [applyPorts, confirm],
  );

  const removeSkill = useCallback(
    async (skill: VirtualMcpSkill) => {
      const ok = await confirm({
        title: `Tirar "${skill.name}" do servidor?`,
        description: 'Todas as portas são desligadas e o nó some do canvas. A skill continua no catálogo.',
        confirmLabel: 'Tirar',
        danger: true,
      });
      if (!ok) return;
      const ports = flagsToPorts(skill);
      await applyPorts(skill, [], { slug: skill.slug, port: ports[0] ?? 'tools', kind: 'remove' });
    },
    [applyPorts, confirm],
  );

  // Conectar uma porta do servidor ao handle da mesma porta na skill = ligar a
  // flag. O modo estrito aceita começar por qualquer ponta; a conexão chega
  // sempre orientada servidor → skill.
  const onConnect = useCallback(
    (connection: Connection) => {
      const port = portOfHandle(connection.sourceHandle);
      const slug = slugOfNodeId(connection.target);
      if (!port || !slug || connection.source !== SERVER_ID || portOfSkillHandle(connection.targetHandle) !== port) return;
      const skill = detail.skills.find((item) => item.slug === slug);
      if (!skill) return;
      const current = flagsToPorts(skill);
      if (current.includes(port)) return;
      void applyPorts(skill, [...current, port], { slug, port, kind: 'add' });
    },
    [applyPorts, detail.skills],
  );

  const isValidConnection = useCallback<IsValidConnection<CanvasEdge>>(
    (connection) => {
      if (!canEdit) return false;
      const port = portOfHandle(connection.sourceHandle);
      const slug = slugOfNodeId(connection.target ?? '');
      if (!port || !slug || connection.source !== SERVER_ID || portOfSkillHandle(connection.targetHandle) !== port) return false;
      return !edges.some((edge) => edge.id === portEdgeId(port, slug));
    },
    [canEdit, edges],
  );

  // Apagar uma aresta (Delete/Backspace ou o ✕ do rótulo) = desligar a porta.
  const removeEdge = useCallback(
    (edge: PortEdge) => {
      if (!edge.data || edge.data.saving) return;
      const skill = detail.skills.find((item) => item.slug === edge.data!.slug);
      if (skill) togglePort(skill, edge.data.port, false);
    },
    [detail.skills, togglePort],
  );

  useEffect(() => {
    const onRemove = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail.id;
      const edge = edges.find((item) => item.id === id);
      if (edge && edge.type === 'port') removeEdge(edge as PortEdge);
    };
    const onSessions = () => onOpenSessions();
    window.addEventListener('canvas:remove-edge', onRemove);
    window.addEventListener('canvas:open-sessions', onSessions);
    return () => {
      window.removeEventListener('canvas:remove-edge', onRemove);
      window.removeEventListener('canvas:open-sessions', onSessions);
    };
  }, [edges, removeEdge, onOpenSessions]);

  // O React Flow pede confirmação antes de apagar; aqui decidimos o que "apagar" significa.
  const onBeforeDelete = useCallback<OnBeforeDelete<CanvasNode, CanvasEdge>>(
    async ({ nodes: toDelete, edges: edgesToDelete }) => {
      if (!canEdit) return false;
      const skillNodes = toDelete.filter((node) => slugOfNodeId(node.id));
      if (skillNodes.length > 0) {
        const names = skillNodes.map((node) => (node.data as { name: string }).name);
        const ok = await confirm({
          title: skillNodes.length === 1 ? `Tirar "${names[0]}" do servidor?` : `Tirar ${skillNodes.length} skills do servidor?`,
          description: 'As portas são desligadas e os nós somem do canvas. As skills continuam no catálogo.',
          confirmLabel: 'Tirar',
          danger: true,
        });
        if (!ok) return false;
        for (const node of skillNodes) {
          const skill = detail.skills.find((item) => item.slug === slugOfNodeId(node.id));
          if (skill) await applyPorts(skill, [], { slug: skill.slug, port: flagsToPorts(skill)[0] ?? 'tools', kind: 'remove' });
        }
        // Já cuidamos de tudo: o React Flow não precisa apagar nada.
        return false;
      }
      for (const edge of edgesToDelete) {
        if (edge.type === 'port') removeEdge(edge as PortEdge);
      }
      return false;
    },
    [applyPorts, canEdit, confirm, detail.skills, removeEdge],
  );

  const onNodesDelete = useCallback<OnNodesDelete<CanvasNode>>(() => void 0, []);

  // ----------------------------------------------------------- adicionar --
  const addSkill = useCallback(() => {
    openPalette({
      page: 'pick-skill',
      title: `Adicionar a ${detail.name}`,
      exclude: new Set(detail.skills.map((skill) => skill.slug)),
      onPick: (skill) => setAdding(skill),
    });
  }, [openPalette, detail.name, detail.skills]);

  const confirmAdd = useCallback(
    async (ports: Port[]) => {
      if (!adding) return;
      setAddBusy(true);
      const serverNode = nodes.find((node) => node.id === SERVER_ID);
      const taken = nodes.filter((node) => slugOfNodeId(node.id)).map((node) => node.position);
      const position = freeSlot(serverNode?.position ?? DEFAULT_SERVER, taken);
      const marks: Pending[] = ports.map((port) => ({ slug: adding.slug, port, kind: 'add' }));
      setPending((current) => [...current, ...marks]);
      const ok = await runLink(adding.slug, ports, position);
      setPending((current) => current.filter((item) => !marks.includes(item)));
      if (ok) {
        const fresh = await refetch(detail.slug);
        onDetail(fresh);
        setSelection({ kind: 'skill', slug: adding.slug });
        toast.success(`"${adding.name}" adicionada.`);
      }
      setAddBusy(false);
      setAdding(null);
    },
    [adding, detail.slug, nodes, onDetail, runLink, toast],
  );

  // ------------------------------------------------------------- layout --
  const relayout = useCallback(async () => {
    const ok = await confirm({
      title: 'Reorganizar o canvas?',
      description: 'Recalcula todas as posições — servidor à esquerda, skills em coluna por nome — e descarta o arranjo manual.',
      confirmLabel: 'Reorganizar',
    });
    if (!ok) return;
    const { server, internet, positions } = autoLayout(detail);
    setNodes((current) =>
      current.map((node) => {
        const slug = slugOfNodeId(node.id);
        if (slug) return { ...node, position: positions.get(slug) ?? node.position };
        if (node.id === SERVER_ID) return { ...node, position: server };
        if (node.id === INTERNET_ID) return { ...node, position: internet };
        return node;
      }),
    );
    try {
      await setMcpCanvas(detail.slug, {
        layout: { server, internet },
        positions: [...positions.entries()].map(([slug, point]) => ({ slug, x: point.x, y: point.y })),
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
    setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1 }), 50);
  }, [confirm, detail, fitView, setNodes, toast]);

  useRegisterCommands(
    [
      ...(canEdit ? [{ id: 'canvas-add', label: 'Adicionar skill ao servidor', group: 'Recurso' as const, icon: <Plus />, shortcut: 'a', run: addSkill }] : []),
      { id: 'canvas-fit', label: 'Enquadrar o canvas', group: 'Recurso', icon: <Maximize />, shortcut: 'f', run: () => void fitView({ padding: 0.25, maxZoom: 1 }) },
      ...(canEdit ? [{ id: 'canvas-relayout', label: 'Reorganizar o canvas (auto layout)', group: 'Recurso' as const, icon: <LayoutTemplate />, run: relayout }] : []),
    ],
    [canEdit, addSkill, relayout],
  );

  // Atalhos do palco fora de campos de texto.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelection(null);
        return;
      }
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      // `preventDefault`: a letra do atalho não pode cair no campo da paleta que ele abre.
      if (event.key === 'a' && canEdit) {
        event.preventDefault();
        addSkill();
      }
      if (event.key === 'f') {
        event.preventDefault();
        void fitView({ padding: 0.25, maxZoom: 1 });
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [addSkill, canEdit, fitView]);

  // Seleção: só um clique abre a gaveta; no fundo, fecha. Com
  // `selectNodesOnDrag` desligado, arrastar não seleciona, e o React Flow
  // descarta o clique que termina um arraste — então clicar e arrastar não se
  // confundem. O `select` que ainda chega por aqui vem do teclado (Enter).
  const selectNode = useCallback((id: string) => {
    const slug = slugOfNodeId(id);
    setSelection(slug ? { kind: 'skill', slug } : id === SERVER_ID ? { kind: 'server' } : { kind: 'internet' });
  }, []);

  const onNodeClick = useCallback<NodeMouseHandler<CanvasNode>>((_event, node) => selectNode(node.id), [selectNode]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      onNodesChange(changes);
      for (const change of changes) {
        if (change.type === 'select' && change.selected) selectNode(change.id);
      }
    },
    [onNodesChange, selectNode],
  );

  const empty = detail.skills.length === 0 && pending.length === 0;

  return (
    <div className="stage-wrap">
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={onNodeClick}
        selectNodesOnDrag={false}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onBeforeDelete={onBeforeDelete}
        onNodesDelete={onNodesDelete}
        onNodeDragStop={(_event, node, dragged) => (dragged ?? [node]).forEach((item) => queuePosition(item))}
        onPaneClick={() => setSelection(null)}
        nodesConnectable={canEdit}
        nodesDraggable={canEdit}
        snapToGrid
        snapGrid={[GRID, GRID]}
        minZoom={0.3}
        maxZoom={1.6}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
      />

      <div className="stage-actions">
        {canEdit && (
          <Button onClick={addSkill}>
            <Plus /> Adicionar skill
          </Button>
        )}
      </div>

      <div className="stage-toolbar" role="toolbar" aria-label="Canvas">
        <button type="button" className="icon-btn" title="Aproximar" onClick={() => void zoomIn()}>
          <Plus />
        </button>
        <button type="button" className="icon-btn" title="Afastar" onClick={() => void zoomOut()}>
          <Minus />
        </button>
        <button type="button" className="icon-btn" title="Enquadrar (f)" onClick={() => void fitView({ padding: 0.25, maxZoom: 1 })}>
          <Maximize />
        </button>
        {canEdit && (
          <>
            <div className="sep" />
            <button type="button" className="icon-btn" title="Reorganizar (auto layout)" onClick={() => void relayout()}>
              <LayoutTemplate />
            </button>
          </>
        )}
      </div>

      <div className="stage-legend" aria-hidden>
        <span>
          <i className="tools" /> Tools
        </span>
        <span>
          <i className="resources" /> Resources
        </span>
        <span>
          <i className="prompts" /> Prompts
        </span>
      </div>

      {!empty && canEdit && <p className="stage-hint">Arraste de uma porta até uma skill para ligá-la · Delete tira a aresta · a última aresta tira a skill</p>}

      <NodeDrawer
        selection={selection}
        detail={detail}
        online={online}
        onlineWindowMs={onlineWindowMs}
        busySlug={busySlug}
        canEdit={canEdit}
        onClose={() => setSelection(null)}
        onTogglePort={togglePort}
        onRemoveSkill={(skill) => void removeSkill(skill)}
        onOpenSessions={onOpenSessions}
      />

      <AddSkillDialog skill={adding} serverName={detail.name} busy={addBusy} onConfirm={(ports) => void confirmAdd(ports)} onClose={() => (addBusy ? null : setAdding(null))} />
    </div>
  );
}

/** Recarrega o detalhe do servidor depois de uma escrita. */
async function refetch(slug: string): Promise<VirtualMcpDetail> {
  const { getMcp } = await import('../../api.js');
  return getMcp(slug);
}
