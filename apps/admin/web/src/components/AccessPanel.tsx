import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Crown, Globe, Lock, Search, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react';
import {
  ACCESS_HINT,
  ACCESS_LABEL,
  ACCESS_LEVELS,
  ROLE_LABEL,
  canManage,
  canOwn,
  formatDateTime,
  lookupUsers,
  share,
  unshare,
  type AccessKind,
  type AccessLevel,
  type Accessible,
  type EffectiveAccess,
  type Grant,
  type SessionUser,
  type UserLookup,
} from '../api.js';
import { Badge, Button, EmptyRow, Panel, useClickOutside, useConfirm, useDebounced } from './ui.js';
import { initials } from './SkillIcon.js';
import { useToast } from './Toast.js';

const KIND_LABEL: Record<AccessKind, string> = { skill: 'skill', catalog: 'catálogo', mcp: 'servidor' };

/**
 * O selo de origem do acesso nas listas (`docs/12-acesso-granular.md`
 * decisão 19): dono, o nível concedido, ou "público"/"aberto" quando a
 * sessão só chega por aí. Admin é dono de tudo e não precisa de selo.
 */
export function AccessBadge({
  object,
  user,
  publicLabel = 'pública',
}: {
  object: Accessible & { isPublic?: boolean; isOpen?: boolean };
  user: SessionUser;
  publicLabel?: string;
}) {
  if (user.role === 'admin') return null;
  const access = object.access;
  if (access === 'owner') {
    return (
      <Badge tone="accent" title="Você é o dono: faz tudo, inclusive apagar e transferir">
        <Crown style={{ width: 11, height: 11 }} /> dono
      </Badge>
    );
  }
  if (access === 'manage' || access === 'edit') {
    return (
      <Badge tone="info" title={`Concedido a você: ${ACCESS_LABEL[access]}`}>
        <ShieldCheck style={{ width: 11, height: 11 }} /> {ACCESS_LABEL[access]}
      </Badge>
    );
  }
  if (object.isPublic || object.isOpen) {
    return (
      <Badge tone="outline" title="Legível por qualquer conta">
        <Globe style={{ width: 11, height: 11 }} /> {publicLabel}
      </Badge>
    );
  }
  return (
    <Badge tone="outline" title="Você só lê: por concessão ou por um contêiner que vê">
      <Lock style={{ width: 11, height: 11 }} /> leitura
    </Badge>
  );
}

/** A frase de acesso da sessão, para o cabeçalho de uma página. */
export function accessSentence(access: EffectiveAccess): string {
  if (access === 'owner') return 'você é o dono';
  if (access === null) return 'sem acesso';
  return `seu acesso: ${ACCESS_LABEL[access]}`;
}

// -------------------------------------------------------------- busca ------

/**
 * Escolhe uma conta pelo nome ou e-mail (decisão 13): a busca é do servidor,
 * só contas ativas, a partir de dois caracteres.
 */
export function UserPicker({
  value,
  onChange,
  exclude,
  placeholder = 'Nome ou e-mail da conta',
  autoFocus,
}: {
  value: UserLookup | null;
  onChange: (user: UserLookup | null) => void;
  exclude?: Set<string>;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const dq = useDebounced(query, 250);
  const [options, setOptions] = useState<UserLookup[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useClickOutside(box, () => setOpen(false), open);

  useEffect(() => {
    if (dq.trim().length < 2) {
      setOptions([]);
      return;
    }
    let active = true;
    lookupUsers(dq.trim())
      .then((data) => active && setOptions(data.items.filter((item) => !exclude?.has(item.uuid))))
      .catch(() => active && setOptions([]));
    return () => {
      active = false;
    };
  }, [dq, exclude]);

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="skill-icon sm" aria-hidden>
          <span className="mono">{initials(value.name || value.email)}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="row-title truncate">{value.name}</span>
          <span className="row-sub truncate">
            {value.email} · {ROLE_LABEL[value.role]}
          </span>
        </span>
        <Button variant="quiet" size="sm" onClick={() => onChange(null)}>
          trocar
        </Button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative">
      <label className="search-bar">
        <Search />
        <input
          className="field"
          value={query}
          autoFocus={autoFocus}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </label>
      {open && query.trim().length >= 2 && (
        <div className="menu" style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 20 }}>
          {options.map((item) => (
            <button
              key={item.uuid}
              type="button"
              className="mi"
              onClick={() => {
                onChange(item);
                setQuery('');
                setOpen(false);
              }}
            >
              <span className="min-w-0">
                <span className="row-title truncate">{item.name}</span>
                <span className="row-sub truncate">
                  {item.email} · {ROLE_LABEL[item.role]}
                </span>
              </span>
            </button>
          ))}
          {options.length === 0 && <div className="hd">Nenhuma conta ativa com esse nome</div>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- o painel ----

type AccessObject = Accessible & {
  slug: string;
  name: string;
  grants: Grant[];
  isPublic?: boolean;
};

/**
 * A seção "Acesso" da página de uma skill, catálogo ou servidor
 * (`docs/12-acesso-granular.md` §5.1): o dono (com transferir), o flag
 * público e a tabela de concessões. Quem tem só `view` ou `edit` vê o dono
 * e o flag; a lista de contas é de quem tem `manage`.
 */
export function AccessPanel<T extends AccessObject>({
  kind,
  object,
  user,
  onPatch,
  onChanged,
  publicHint,
  privateCount,
  readOnly = false,
}: {
  kind: AccessKind;
  object: T;
  user: SessionUser;
  /** Aplica `isPublic` ou `ownerUserUuid` no objeto e devolve o estado novo. */
  onPatch: (body: { isPublic?: boolean; ownerUserUuid?: string }) => Promise<T>;
  onChanged: (updated: T) => void;
  /** O que "público" significa neste tipo, para a caixa. */
  publicHint?: string;
  /** Quantas skills privadas ficariam públicas ao marcar (o aviso da decisão 15). */
  privateCount?: number;
  /** A ficha de leitura: dono, flag e concessões como texto, sem transferir, marcar, conceder ou revogar. */
  readOnly?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [target, setTarget] = useState<UserLookup | null>(null);
  const [level, setLevel] = useState<AccessLevel>('view');
  const [newOwner, setNewOwner] = useState<UserLookup | null>(null);

  const manages = canManage(object.access);
  // Só leitura: o que a sessão vê é o mesmo, mas nenhum controle aparece.
  const owns = canOwn(object.access) && !readOnly;
  const edits = manages && !readOnly;
  const what = KIND_LABEL[kind];
  const isAdminView = user.role === 'admin';

  async function setPublic(isPublic: boolean) {
    setBusy(true);
    try {
      onChanged(await onPatch({ isPublic }));
      toast.success(isPublic ? `${object.name} agora é público.` : `${object.name} voltou a ser privado.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function transfer(event: FormEvent) {
    event.preventDefault();
    if (!newOwner) return;
    const ok = await confirm({
      title: `Transferir "${object.name}" para ${newOwner.name}?`,
      description: isAdminView
        ? `${newOwner.email} passa a ser o dono, com todos os poderes sobre este ${what}.`
        : `${newOwner.email} passa a ser o dono, e você deixa de ser. Só um administrador ou o novo dono pode devolver.`,
      confirmLabel: 'Transferir',
      danger: !isAdminView,
    });
    if (!ok) return;
    setBusy(true);
    try {
      onChanged(await onPatch({ ownerUserUuid: newOwner.uuid }));
      toast.success(`${object.name} agora é de ${newOwner.email}.`);
      setNewOwner(null);
      setTransferring(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    setBusy(true);
    try {
      const saved = await share(kind, object.slug, target.email, level);
      const grants = [...object.grants.filter((item) => item.userUuid !== saved.userUuid), saved];
      onChanged({ ...object, grants });
      toast.success(`${saved.email} agora pode ${ACCESS_LABEL[saved.level]}.`);
      setTarget(null);
      setLevel('view');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeLevel(item: Grant, next: AccessLevel) {
    if (next === item.level) return;
    setBusy(true);
    try {
      const saved = await share(kind, object.slug, item.email, next);
      onChanged({ ...object, grants: object.grants.map((current) => (current.userUuid === saved.userUuid ? saved : current)) });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: Grant) {
    const ok = await confirm({
      title: `Tirar o acesso de ${item.name}?`,
      description: `${item.email} deixa de ${ACCESS_LABEL[item.level]} este ${what}. Vínculos que a conta já fez ficam.`,
      confirmLabel: 'Revogar',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await unshare(kind, object.slug, item.email);
      onChanged({ ...object, grants: object.grants.filter((current) => current.userUuid !== item.userUuid) });
      toast.success(`${item.email} perdeu o acesso.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const excluded = new Set<string>([
    ...object.grants.map((item) => item.userUuid),
    ...(object.ownerUserUuid ? [object.ownerUserUuid] : []),
  ]);

  return (
    <Panel title="Acesso" icon={<Users />}>
      <dl className="kv">
        <dt>Dono</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span>
            {object.ownerEmail ?? 'nenhum (só administradores)'}
            {object.ownerUserUuid !== null && object.ownerUserUuid === user.uuid && ' — você'}
          </span>
          {owns && !transferring && (
            <Button variant="quiet" size="sm" onClick={() => setTransferring(true)} disabled={busy}>
              transferir
            </Button>
          )}
        </dd>
        {!canOwn(object.access) && (
          <>
            <dt>Seu acesso</dt>
            <dd>{object.access ? ACCESS_LABEL[object.access] : '—'}</dd>
          </>
        )}
        {readOnly && object.isPublic !== undefined && (
          <>
            <dt>Visibilidade</dt>
            <dd>
              {object.isPublic ? 'público: qualquer conta do painel e o site leem, sem concessão' : 'privado: só o dono, os administradores e as contas com concessão'}
              {publicHint && object.isPublic && <span className="hint block">{publicHint}</span>}
            </dd>
          </>
        )}
      </dl>

      {transferring && (
        <form onSubmit={transfer} className="mt-3 grid gap-2">
          <UserPicker value={newOwner} onChange={setNewOwner} autoFocus placeholder="Quem passa a ser o dono" />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !newOwner}>
              Transferir
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setTransferring(false);
                setNewOwner(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {object.isPublic !== undefined && !readOnly && (
        <label className="check mt-3" title={publicHint}>
          <input
            type="checkbox"
            checked={object.isPublic}
            disabled={!manages || busy}
            onChange={(event) => void setPublic(event.target.checked)}
          />
          <span>
            Público: qualquer conta do painel e o site leem, sem concessão
            {publicHint && <span className="hint block">{publicHint}</span>}
          </span>
        </label>
      )}
      {object.isPublic !== undefined && !object.isPublic && edits && (privateCount ?? 0) > 0 && (
        <p className="hint mt-1">
          Ao marcar, {privateCount === 1 ? '1 skill privada fica pública' : `${privateCount} skills privadas ficam públicas`} por
          aqui.
        </p>
      )}

      {manages && (
        <>
          {edits && (
          <form onSubmit={grant} className="mt-4 grid gap-2">
            <span className="label">Compartilhar com</span>
            <UserPicker value={target} onChange={setTarget} exclude={excluded} />
            <div className="flex flex-wrap items-center gap-2">
              <select className="field" style={{ maxWidth: 200 }} value={level} onChange={(event) => setLevel(event.target.value as AccessLevel)} aria-label="Nível">
                {ACCESS_LEVELS.map((item) => (
                  <option key={item} value={item}>
                    {ACCESS_LABEL[item]} — {ACCESS_HINT[item]}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" disabled={busy || !target}>
                Conceder
              </Button>
            </div>
          </form>
          )}

          {readOnly && <span className="label mt-4 block">Quem mais tem acesso</span>}
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr>
                  <th>Conta</th>
                  <th>Nível</th>
                  <th className="hidden md:table-cell">Concedido</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {object.grants.map((item) => (
                  <tr key={item.userUuid}>
                    <td>
                      <span className="flex items-center gap-2">
                        <UserRound style={{ width: 14, height: 14, color: 'var(--text-faint)' }} />
                        <span className="min-w-0">
                          <span className="row-title truncate">{item.name}</span>
                          <span className="row-sub truncate">
                            {item.email} · {ROLE_LABEL[item.role]}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      {readOnly ? (
                        <Badge tone="info" title={ACCESS_HINT[item.level]}>
                          {ACCESS_LABEL[item.level]}
                        </Badge>
                      ) : (
                        <select
                          className="field"
                          style={{ minWidth: 120 }}
                          value={item.level}
                          disabled={busy}
                          onChange={(event) => void changeLevel(item, event.target.value as AccessLevel)}
                          aria-label={`Nível de ${item.email}`}
                        >
                          {ACCESS_LEVELS.map((option) => (
                            <option key={option} value={option}>
                              {ACCESS_LABEL[option]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="hidden md:table-cell">
                      <span className="row-sub whitespace-nowrap">
                        {formatDateTime(item.createdAt)}
                        {item.grantedByEmail && ` por ${item.grantedByEmail}`}
                      </span>
                    </td>
                    <td className="num">
                      {edits && (
                        <button type="button" className="row-action danger" title="Revogar" disabled={busy} onClick={() => void revoke(item)}>
                          <Trash2 />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {object.grants.length === 0 && <EmptyRow colSpan={4}>Ninguém além do dono e dos administradores</EmptyRow>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!manages && (
        <p className="panel-hint mt-3 mb-0">
          Quem mais tem acesso é visível só para quem administra este {what}.
        </p>
      )}
    </Panel>
  );
}
