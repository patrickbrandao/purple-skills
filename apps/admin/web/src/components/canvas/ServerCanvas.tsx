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
import { LayoutTemplate, Library, Maximize, Minus, Plus } from 'lucide-react';
import {
  getMcp,
  getMcpOnline,
  linkCatalogToMcp,
  linkSkillToMcp,
  setMcpCanvas,
  unlinkCatalogFromMcp,
  unlinkSkillFromMcp,
  type CanvasPoint,
  type CanvasPosition,
  type LinkFlags,
  type OnlineCount,
  type VirtualMcpDetail,
} from '../../api.js';
import { usePalette, useRegisterCommands } from '../commands.js';
import { useToast } from '../Toast.js';
import { Button, isChordKey, isTypingTarget, useConfirm, usePolling } from '../ui.js';
import { useTheme } from '../../themeStore.js';
import { nodeTypes } from './nodes.js';
import { edgeTypes } from './edges.js';
import { AddSkillDialog, pickedKey, type Picked } from './AddSkillDialog.js';
import { NodeDrawer, type Selection } from './NodeDrawer.js';
import { DEFAULT_INTERNET, DEFAULT_SERVER, GRID, autoLayout, freeSlot, placeNodes, snap } from './layout.js';
import { createWriteQueue, effectivePorts, hasPending, nextPorts, unlinkMarks, type Pending } from './pending.js';
import {
  INTERNET_ID,
  SERVER_ID,
  SKILL_HANDLE,
  catalogNodeId,
  flagsToPorts,
  nodeIdOf,
  portEdgeId,
  portOfHandle,
  portOfSkillHandle,
  portsToFlags,
  sameTarget,
  skillNodeId,
  targetOfNodeId,
  type CanvasEdge,
  type CanvasNode,
  type Port,
  type PortEdge,
  type Target,
} from './types.js';

/** Uma skill ou um catálogo vinculado, com o que o palco precisa dos dois. */
type Linked = { target: Target; name: string; flags: LinkFlags };

const isSelectedNode = (id: string, selection: Selection): boolean => {
  if (!selection) return false;
  if (selection.kind === 'skill' || selection.kind === 'catalog') return id === nodeIdOf(selection);
  return id === (selection.kind === 'server' ? SERVER_ID : INTERNET_ID);
};

/**
 * O palco de um servidor: o vMCP com as três portas, as skills e os catálogos
 * vinculados e o globo da Internet com o contador de clientes online. O
 * estado vem do servidor (`detail`); só a posição dos nós é local, persistida
 * no vMCP.
 *
 * Toda aresta é gravada na hora: conectar liga a porta (`PUT` do vínculo),
 * desconectar desliga — e a última aresta que sai tira a skill (ou o
 * catálogo) do servidor. Skill e catálogo têm os mesmos gestos; só o `PUT`
 * muda (`docs/11-catalogos.md` §5).
 *
 * O `PUT` leva o conjunto inteiro de portas, não a diferença. Por isso cada
 * gesto parte do gravado **mais** o que ainda está em andamento, e as escritas
 * saem uma por vez, na ordem dos gestos (`pending.ts`): dois gestos rápidos no
 * mesmo item não se desfazem um ao outro.
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
  // O que está em andamento, do gesto até o detalhe voltar (`pending.ts`). É
  // daqui que saem as arestas "salvando", o "ocupado" de cada alvo e o ponto
  // de partida do próximo gesto.
  const [pending, setPending] = useState<Pending[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [online, setOnline] = useState<OnlineCount | null>(null);
  const [adding, setAdding] = useState<Picked | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const fitted = useRef(false);

  const isBusy = useCallback((target: Target) => hasPending(pending, target), [pending]);

  /** Tudo que está ligado ao servidor, skill e catálogo, na mesma forma. */
  const linked = useMemo<Linked[]>(
    () => [
      ...detail.skills.map((skill) => ({ target: { kind: 'skill' as const, slug: skill.slug }, name: skill.name, flags: skill })),
      ...detail.catalogs.map((catalog) => ({ target: { kind: 'catalog' as const, slug: catalog.slug }, name: catalog.name, flags: catalog })),
    ],
    [detail.skills, detail.catalogs],
  );

  const findLinked = useCallback((target: Target) => linked.find((item) => sameTarget(item.target, target)), [linked]);

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
        if (targetOfNodeId(node.id)) known.set(node.id, node.position);
      }
      const positions = placeNodes(detail, known);
      // As portas do servidor contam arestas: skills e catálogos.
      const counts: Record<Port, number> = { tools: 0, resources: 0, prompts: 0 };
      for (const item of linked) for (const port of flagsToPorts(item.flags)) counts[port] += 1;
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
        ...detail.catalogs.map((catalog) =>
          upsert<CanvasNode>({
            id: catalogNodeId(catalog.slug),
            type: 'catalog',
            position: positions.get(catalogNodeId(catalog.slug))!,
            data: {
              slug: catalog.slug,
              name: catalog.name,
              isActive: catalog.isActive,
              ports: flagsToPorts(catalog),
              activeSkillCount: catalog.activeSkillCount,
              skillCount: catalog.skillCount,
              busy: isBusy({ kind: 'catalog', slug: catalog.slug }),
            },
            zIndex: 2,
            deletable: canEdit,
          }),
        ),
        ...detail.skills.map((skill) =>
          upsert<CanvasNode>({
            id: skillNodeId(skill.slug),
            type: 'skill',
            position: positions.get(skillNodeId(skill.slug))!,
            data: {
              slug: skill.slug,
              name: skill.name,
              icon: skill.icon,
              ports: flagsToPorts(skill),
              busy: isBusy({ kind: 'skill', slug: skill.slug }),
            },
            zIndex: 2,
            deletable: canEdit,
          }),
        ),
      ];
    });
  }, [detail, linked, online?.total, isBusy, canEdit, setNodes]);

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
    const portEdge = (target: Target, port: Port, saving: boolean): PortEdge => ({
      id: portEdgeId(port, target),
      type: 'port',
      source: SERVER_ID,
      sourceHandle: `port-${port}`,
      target: nodeIdOf(target),
      targetHandle: SKILL_HANDLE[port],
      className: `edge-port ${port}${saving ? ' saving' : ''}`,
      data: { port, target, saving },
      deletable: canEdit && !saving,
      zIndex: 1,
    });
    for (const item of linked) {
      // A mesma conta de quem grava (`togglePort`, `onConnect`): o que a tela
      // mostra é o ponto de partida do próximo gesto.
      for (const port of effectivePorts(item.flags, pending, item.target)) {
        const saving = pending.some((change) => sameTarget(change.target, item.target) && change.port === port);
        list.push(portEdge(item.target, port, saving));
      }
    }
    // Nós recém-adicionados ainda sem linha em `detail` (pendentes de add).
    for (const change of pending) {
      if (change.kind !== 'add' || findLinked(change.target)) continue;
      list.push({ ...portEdge(change.target, change.port, true), deletable: false });
    }
    return list;
  }, [linked, findLinked, pending, online?.total, detail.onlineSessions, canEdit]);

  // ---------------------------------------------------------- persistência --
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<{
    positions: Map<string, CanvasPoint>;
    catalogPositions: Map<string, CanvasPoint>;
    layout: { server?: CanvasPoint; internet?: CanvasPoint };
  }>({ positions: new Map(), catalogPositions: new Map(), layout: {} });

  const flushPositions = useCallback(() => {
    const queue = saveQueue.current;
    saveQueue.current = { positions: new Map(), catalogPositions: new Map(), layout: {} };
    const toList = (map: Map<string, CanvasPoint>): CanvasPosition[] => [...map.entries()].map(([slug, point]) => ({ slug, x: point.x, y: point.y }));
    const positions = toList(queue.positions);
    const catalogPositions = toList(queue.catalogPositions);
    const layout = queue.layout;
    if (positions.length === 0 && catalogPositions.length === 0 && !layout.server && !layout.internet) return;
    setMcpCanvas(detail.slug, {
      positions: positions.length ? positions : undefined,
      catalogPositions: catalogPositions.length ? catalogPositions : undefined,
      layout: Object.keys(layout).length ? layout : undefined,
    }).catch((err) => toast.error(`Não foi possível salvar as posições: ${(err as Error).message}`));
  }, [detail.slug, toast]);

  const queuePosition = useCallback(
    (node: Node) => {
      const point = { x: snap(node.position.x), y: snap(node.position.y) };
      const target = targetOfNodeId(node.id);
      if (target?.kind === 'skill') saveQueue.current.positions.set(target.slug, point);
      else if (target?.kind === 'catalog') saveQueue.current.catalogPositions.set(target.slug, point);
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
  // Uma escrita de vínculo por vez, na ordem dos gestos (`pending.ts`).
  const [enqueue] = useState(createWriteQueue);

  const runLink = useCallback(
    async (target: Target, ports: Port[], position?: CanvasPoint) => {
      try {
        // A resposta é o detalhe da skill (ou do servidor); o do servidor é
        // recarregado por quem nos chamou, para os dois caminhos serem iguais.
        const flags = { ...portsToFlags(ports), position };
        if (target.kind === 'skill') await linkSkillToMcp(target.slug, detail.slug, flags);
        else await linkCatalogToMcp(detail.slug, target.slug, flags);
        return true;
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      }
    },
    [detail.slug, toast],
  );

  const runUnlink = useCallback(
    async (target: Target) => {
      try {
        if (target.kind === 'skill') await unlinkSkillFromMcp(target.slug, detail.slug);
        else await unlinkCatalogFromMcp(detail.slug, target.slug);
        return true;
      } catch (err) {
        toast.error((err as Error).message);
        return false;
      }
    },
    [detail.slug, toast],
  );

  /**
   * Recarrega o detalhe do servidor depois de uma escrita que passou. A falha
   * daqui não desfaz nada — o vínculo já está gravado —, e o aviso diz isso com
   * todas as letras: quem lê só "erro" refaz o gesto achando que não gravou.
   */
  const reload = useCallback(async () => {
    try {
      onDetail(await getMcp(detail.slug));
      return true;
    } catch (err) {
      toast.error(`Gravado, mas o canvas não pôde ser recarregado: ${(err as Error).message}. Recarregue a página para ver o estado atual.`);
      return false;
    }
  }, [detail.slug, onDetail, toast]);

  /**
   * Reaplica as portas de um item: com nenhuma, desvincula (e o nó some). As
   * marcas entram já no gesto e só saem depois de o detalhe voltar — até lá é
   * por elas que as arestas e o próximo gesto sabem o que está em andamento.
   */
  const applyPorts = useCallback(
    async (item: Linked, ports: Port[], marks: Pending[]) => {
      setPending((current) => [...current, ...marks]);
      try {
        await enqueue(async () => {
          const ok = ports.length === 0 ? await runUnlink(item.target) : await runLink(item.target, ports);
          if (!ok || !(await reload()) || ports.length > 0) return;
          // O que saiu é o que a gaveta mostra agora? Então ela fecha.
          const selected = selectionRef.current;
          if ((selected?.kind === 'skill' || selected?.kind === 'catalog') && sameTarget(selected, item.target)) setSelection(null);
        });
      } finally {
        setPending((current) => current.filter((entry) => !marks.includes(entry)));
      }
    },
    [enqueue, reload, runLink, runUnlink],
  );

  const noun = (target: Target) => (target.kind === 'skill' ? 'A skill' : 'O catálogo');

  const togglePort = useCallback(
    (target: Target, port: Port, on: boolean) => {
      const item = findLinked(target);
      if (!item) return;
      // Parte do gravado MAIS o que está em andamento — a conta das arestas. O
      // `PUT` substitui as três flags: partir só de `item.flags` religaria a
      // porta que o gesto anterior acabou de desligar, e nas caixas da gaveta
      // perguntaria "era a última?" quando não era (`tasks/053`).
      const ports = nextPorts(effectivePorts(item.flags, pending, target), port, on);
      if (!ports) return;
      if (ports.length === 0) {
        void confirm({
          title: `Tirar "${item.name}" do servidor?`,
          description: `Era a última porta. ${noun(target)} sai deste servidor e continua existindo${target.kind === 'skill' ? ' no catálogo e nos outros servidores' : ', com suas skills, nos outros servidores'}.`,
          confirmLabel: 'Tirar',
          danger: true,
        }).then((ok) => {
          if (ok) void applyPorts(item, ports, unlinkMarks(target));
        });
        return;
      }
      void applyPorts(item, ports, [{ target, port, kind: on ? 'add' : 'remove' }]);
    },
    [applyPorts, confirm, findLinked, pending],
  );

  const removeTarget = useCallback(
    async (target: Target) => {
      const item = findLinked(target);
      if (!item) return;
      const ok = await confirm({
        title: `Tirar "${item.name}" do servidor?`,
        description: `Todas as portas são desligadas e o nó some do canvas. ${noun(target)} continua existindo.`,
        confirmLabel: 'Tirar',
        danger: true,
      });
      if (!ok) return;
      await applyPorts(item, [], unlinkMarks(target));
    },
    [applyPorts, confirm, findLinked],
  );

  // Conectar uma porta do servidor ao handle da mesma porta no nó = ligar a
  // flag. O modo estrito aceita começar por qualquer ponta; a conexão chega
  // sempre orientada servidor → nó.
  const onConnect = useCallback(
    (connection: Connection) => {
      const port = portOfHandle(connection.sourceHandle);
      const target = targetOfNodeId(connection.target);
      if (!port || !target || connection.source !== SERVER_ID || portOfSkillHandle(connection.targetHandle) !== port) return;
      const item = findLinked(target);
      if (!item) return;
      const ports = nextPorts(effectivePorts(item.flags, pending, target), port, true);
      if (!ports) return;
      void applyPorts(item, ports, [{ target, port, kind: 'add' }]);
    },
    [applyPorts, findLinked, pending],
  );

  const isValidConnection = useCallback<IsValidConnection<CanvasEdge>>(
    (connection) => {
      if (!canEdit) return false;
      const port = portOfHandle(connection.sourceHandle);
      const target = targetOfNodeId(connection.target ?? '');
      if (!port || !target || connection.source !== SERVER_ID || portOfSkillHandle(connection.targetHandle) !== port) return false;
      return !edges.some((edge) => edge.id === portEdgeId(port, target));
    },
    [canEdit, edges],
  );

  // Apagar uma aresta (Delete/Backspace ou o ✕ do rótulo) = desligar a porta.
  const removeEdge = useCallback(
    (edge: PortEdge) => {
      if (!edge.data || edge.data.saving) return;
      togglePort(edge.data.target, edge.data.port, false);
    },
    [togglePort],
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
      const targets = toDelete.map((node) => targetOfNodeId(node.id)).filter((target): target is Target => target !== null);
      if (targets.length > 0) {
        const items = targets.map(findLinked).filter((item): item is Linked => item !== undefined);
        const ok = await confirm({
          title: items.length === 1 ? `Tirar "${items[0]!.name}" do servidor?` : `Tirar ${items.length} itens do servidor?`,
          description: 'As portas são desligadas e os nós somem do canvas. Skills e catálogos continuam existindo.',
          confirmLabel: 'Tirar',
          danger: true,
        });
        if (!ok) return false;
        // `applyPorts` avisa a própria falha e não rejeita: um item que não
        // saiu (ou cuja recarga falhou) não segura os que vêm depois dele.
        for (const item of items) {
          await applyPorts(item, [], unlinkMarks(item.target));
        }
        // Já cuidamos de tudo: o React Flow não precisa apagar nada.
        return false;
      }
      for (const edge of edgesToDelete) {
        if (edge.type === 'port') removeEdge(edge as PortEdge);
      }
      return false;
    },
    [applyPorts, canEdit, confirm, findLinked, removeEdge],
  );

  const onNodesDelete = useCallback<OnNodesDelete<CanvasNode>>(() => void 0, []);

  // ----------------------------------------------------------- adicionar --
  const addSkill = useCallback(() => {
    openPalette({
      page: 'pick-skill',
      title: `Adicionar a ${detail.name}`,
      exclude: new Set(detail.skills.map((skill) => skill.slug)),
      onPick: (skill) => setAdding({ kind: 'skill', skill }),
    });
  }, [openPalette, detail.name, detail.skills]);

  const addCatalog = useCallback(() => {
    openPalette({
      page: 'pick-catalog',
      title: `Adicionar catálogo a ${detail.name}`,
      exclude: new Set(detail.catalogs.map((catalog) => catalog.slug)),
      onPick: (catalog) => setAdding({ kind: 'catalog', catalog }),
    });
  }, [openPalette, detail.name, detail.catalogs]);

  const confirmAdd = useCallback(
    async (ports: Port[]) => {
      if (!adding) return;
      const target: Target = adding.kind === 'skill' ? { kind: 'skill', slug: adding.skill.slug } : { kind: 'catalog', slug: adding.catalog.slug };
      const name = adding.kind === 'skill' ? adding.skill.name : adding.catalog.name;
      setAddBusy(true);
      const serverNode = nodes.find((node) => node.id === SERVER_ID);
      const taken = nodes.filter((node) => targetOfNodeId(node.id)).map((node) => node.position);
      const position = freeSlot(serverNode?.position ?? DEFAULT_SERVER, taken);
      const marks: Pending[] = ports.map((port) => ({ target, port, kind: 'add' }));
      setPending((current) => [...current, ...marks]);
      try {
        await enqueue(async () => {
          // Sem o detalhe novo não há nó para selecionar, e o aviso de `reload`
          // já disse que o vínculo foi gravado.
          if (!(await runLink(target, ports, position)) || !(await reload())) return;
          setSelection(target);
          toast.success(adding.kind === 'skill' ? `"${name}" adicionada.` : `Catálogo "${name}" adicionado.`);
        });
      } finally {
        // Destrava e fecha aconteça o que acontecer: com `addBusy` ligado o
        // diálogo não tem saída — Esc, o clique fora e o Cancelar passam todos
        // por ele —, e a cortina cobre o console inteiro (`tasks/054`).
        setPending((current) => current.filter((item) => !marks.includes(item)));
        setAddBusy(false);
        setAdding(null);
      }
    },
    [adding, enqueue, nodes, reload, runLink, toast],
  );

  // ------------------------------------------------------------- layout --
  const relayout = useCallback(async () => {
    const ok = await confirm({
      title: 'Reorganizar o canvas?',
      description: 'Recalcula todas as posições — servidor à esquerda, catálogos e skills em coluna por nome — e descarta o arranjo manual.',
      confirmLabel: 'Reorganizar',
    });
    if (!ok) return;
    const { server, internet, positions } = autoLayout(detail);
    setNodes((current) =>
      current.map((node) => {
        if (targetOfNodeId(node.id)) return { ...node, position: positions.get(node.id) ?? node.position };
        if (node.id === SERVER_ID) return { ...node, position: server };
        if (node.id === INTERNET_ID) return { ...node, position: internet };
        return node;
      }),
    );
    const bySlug = (kind: Target['kind']): CanvasPosition[] =>
      [...positions.entries()]
        .map(([id, point]) => ({ target: targetOfNodeId(id), point }))
        .filter((entry): entry is { target: Target; point: CanvasPoint } => entry.target?.kind === kind)
        .map(({ target, point }) => ({ slug: target.slug, x: point.x, y: point.y }));
    try {
      await setMcpCanvas(detail.slug, {
        layout: { server, internet },
        positions: bySlug('skill'),
        catalogPositions: bySlug('catalog'),
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
    setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1 }), 50);
  }, [confirm, detail, fitView, setNodes, toast]);

  useRegisterCommands(
    [
      ...(canEdit
        ? [
            { id: 'canvas-add', label: 'Adicionar skill ao servidor', group: 'Recurso' as const, icon: <Plus />, shortcut: 'a', run: addSkill },
            { id: 'canvas-add-catalog', label: 'Adicionar catálogo ao servidor', group: 'Recurso' as const, icon: <Library />, shortcut: 'c', keywords: ['catalogo'], run: addCatalog },
          ]
        : []),
      { id: 'canvas-fit', label: 'Enquadrar o canvas', group: 'Recurso', icon: <Maximize />, shortcut: 'f', run: () => void fitView({ padding: 0.25, maxZoom: 1 }) },
      ...(canEdit ? [{ id: 'canvas-relayout', label: 'Reorganizar o canvas (auto layout)', group: 'Recurso' as const, icon: <LayoutTemplate />, run: relayout }] : []),
    ],
    [canEdit, addSkill, addCatalog, relayout],
  );

  // Atalhos do palco fora de campos de texto.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelection(null);
        return;
      }
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      // `g c` é "ir para Catálogos" e `g a` é "ir para Auditoria" (`App.tsx`): a
      // segunda tecla de um acorde não é atalho de uma letra só.
      if (isChordKey(event)) return;
      // `preventDefault`: a letra do atalho não pode cair no campo da paleta que ele abre.
      if (event.key === 'a' && canEdit) {
        event.preventDefault();
        addSkill();
      }
      if (event.key === 'c' && canEdit) {
        event.preventDefault();
        addCatalog();
      }
      if (event.key === 'f') {
        event.preventDefault();
        void fitView({ padding: 0.25, maxZoom: 1 });
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [addSkill, addCatalog, canEdit, fitView]);

  // Seleção: só um clique abre a gaveta; no fundo, fecha. Com
  // `selectNodesOnDrag` desligado, arrastar não seleciona, e o React Flow
  // descarta o clique que termina um arraste — então clicar e arrastar não se
  // confundem. O `select` que ainda chega por aqui vem do teclado (Enter).
  const selectNode = useCallback((id: string) => {
    const target = targetOfNodeId(id);
    setSelection(target ?? (id === SERVER_ID ? { kind: 'server' } : { kind: 'internet' }));
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

  const empty = linked.length === 0 && pending.length === 0;

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
          <>
            <Button variant="ghost" onClick={addCatalog}>
              <Library /> Adicionar catálogo
            </Button>
            <Button onClick={addSkill}>
              <Plus /> Adicionar skill
            </Button>
          </>
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

      {!empty && canEdit && (
        <p className="stage-hint">Arraste de uma porta até uma skill ou um catálogo para ligá-los · Delete tira a aresta · a última aresta tira o nó</p>
      )}

      <NodeDrawer
        selection={selection}
        detail={detail}
        online={online}
        onlineWindowMs={onlineWindowMs}
        pending={pending}
        canEdit={canEdit}
        onClose={() => setSelection(null)}
        onTogglePort={togglePort}
        onRemove={(target) => void removeTarget(target)}
        onOpenSessions={onOpenSessions}
      />

      {/* `key`: o diálogo fica montado no palco, então sem remontar ele reabre
          com as portas marcadas da vez anterior — e o padrão dele é só Tools. */}
      <AddSkillDialog
        key={pickedKey(adding)}
        picked={adding}
        serverName={detail.name}
        serverIsOpen={detail.isOpen}
        busy={addBusy}
        onConfirm={(ports) => void confirmAdd(ports)}
        onClose={() => (addBusy ? null : setAdding(null))}
      />
    </div>
  );
}
