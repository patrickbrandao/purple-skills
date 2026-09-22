import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BookOpenCheck,
  Globe,
  Library,
  Link2,
  Pencil,
  Server,
  UserRound,
} from 'lucide-react';
import {
  ROLE_HINT,
  ROLE_LABEL,
  getCatalogs,
  getMcps,
  getMyProfile,
  listSkills,
  type SessionUser,
  type UserProfile,
} from '../api.js';
import { Avatar } from '../components/Avatar.js';
import { Badge, Panel, Skel, Status, Tabs } from '../components/ui.js';
import { useToast } from '../components/Toast.js';

/**
 * Minha conta: o perfil em **leitura** (`docs/20-perfil.md`), com o botão que
 * leva à edição (`/account/edit`). É a mesma divisão das contas de admin —
 * ficha e editor em endereços diferentes (`docs/13-fichas-e-acessos.md` §3.4):
 * a tela que se abre todo dia é a que só mostra, e escrever é um passo
 * deliberado.
 *
 * As chaves `psk_` saíram daqui: elas têm tela própria em Configurações → Adm
 * MCP Keys (`/account/admin-keys`), com item de menu direto, e repetir o
 * ponteiro aqui só ocupava a largura da página.
 */
export function AccountPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    let ativo = true;
    getMyProfile()
      .then((fresh) => ativo && setProfile(fresh))
      .catch((err) => ativo && toast.error((err as Error).message));
    return () => {
      ativo = false;
    };
  }, [toast]);

  return (
    <div className="page">
      <div className="page-head">
        <div className="min-w-0 flex items-center gap-3">
          <Avatar
            username={user.username}
            name={profile?.name || user.name}
            stamp={profile?.avatarUpdatedAt ?? user.avatarUpdatedAt}
            className="lg"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate">{profile?.name || user.name}</h1>
              <Badge tone={user.role === 'admin' ? 'accent' : 'outline'} title={ROLE_HINT[user.role]}>
                {ROLE_LABEL[user.role]}
              </Badge>
            </div>
            <p className="sub mono">
              @{user.username} · {user.email}
            </p>
          </div>
        </div>
        <div className="page-actions">
          <Link to="/account/edit" className="btn btn-primary">
            <Pencil /> Editar
          </Link>
        </div>
      </div>

      {/* Uma guia só, e ela fica: é o mesmo cabeçalho da tela de edição, que
          tem três. Sem a barra aqui, as duas telas pareceriam coisas
          diferentes ao alternar entre elas. */}
      <Tabs value="profile" items={[{ key: 'profile', label: 'Perfil', icon: <UserRound /> }]} />

      <div className="grid max-w-[760px] content-start gap-4">
        <Panel title="Perfil" icon={<UserRound />}>
          {profile === null ? (
            <Skel h={160} />
          ) : (
            <dl className="kv props-kv">
              <dt>Nome de exibição</dt>
              <dd>{profile.name}</dd>
              <dt>Usuário</dt>
              <dd className="mono">@{profile.username}</dd>
              <dt>E-mail</dt>
              {/* Só a própria pessoa vê o endereço dela aqui (`docs/19` decisão 8). */}
              <dd className="mono">{user.email}</dd>
              <dt>Papel</dt>
              <dd>
                <Badge tone={user.role === 'admin' ? 'accent' : 'outline'}>{ROLE_LABEL[user.role]}</Badge>
                <span className="hint block">{ROLE_HINT[user.role]}</span>
              </dd>
              <dt>Foto</dt>
              <dd>{profile.hasAvatar ? 'enviada' : 'monograma das iniciais'}</dd>
            </dl>
          )}
        </Panel>

        <AcervoPanel />

        <Panel title="Dados públicos" icon={<Globe />}>
          {profile === null ? (
            <Skel h={140} />
          ) : (
            <>
              <p className="panel-hint">
                {profile.isPublic ? (
                  <>
                    O seu perfil está <strong>no ar</strong> em <code>/u/{profile.username}</code>.
                  </>
                ) : (
                  <>
                    O seu perfil está <strong>fora do ar</strong>: nada daqui aparece para
                    visitantes.
                  </>
                )}{' '}
                O seu e-mail não sai em nenhum dos dois casos.
              </p>
              <dl className="kv props-kv">
                <dt>Estado</dt>
                <dd>
                  {profile.isPublic ? <Status tone="ok">publicado</Status> : <Status tone="off">privado</Status>}
                </dd>
                <dt>Descrição</dt>
                <dd>{profile.bio ? <span className="whitespace-pre-wrap">{profile.bio}</span> : <span className="hint">vazia</span>}</dd>
                <dt>Site</dt>
                <dd>
                  {profile.websiteUrl ? (
                    <a href={profile.websiteUrl} target="_blank" rel="noreferrer noopener" className="link">
                      {profile.websiteUrl}
                    </a>
                  ) : (
                    <span className="hint">nenhum</span>
                  )}
                </dd>
                <dt>Links</dt>
                <dd>
                  {profile.links.length === 0 ? (
                    <span className="hint">nenhum</span>
                  ) : (
                    <ul className="grid gap-1">
                      {profile.links.map((link) => (
                        <li key={`${link.label}${link.url}`} className="flex items-center gap-2">
                          <Link2 className="w-3.5 h-3.5 shrink-0" />
                          <a href={link.url} target="_blank" rel="noreferrer noopener" className="link">
                            {link.label || link.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </dl>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * Quanto a conta possui de cada coisa. São três listas que já existem, contadas
 * pelo recorte `mine` — o mesmo que "Meus" nas telas de servidores, skills e
 * catálogos —, e cada número leva à lista que o produziu. Nenhuma rota nova: o
 * que o painel já sabe responder não vira endpoint por causa de um quadro.
 */
function AcervoPanel() {
  const toast = useToast();
  const [contas, setContas] = useState<{ mcps: number; skills: number; catalogs: number } | null>(null);

  useEffect(() => {
    let ativo = true;
    // `limit: 1` nas skills: o que interessa é o `total` da busca, e não a
    // página — pedir o padrão traria dezenas de fichas para mostrar um número.
    Promise.all([getMcps('mine'), listSkills({ scope: 'mine', limit: 1 }), getCatalogs('mine')])
      .then(([mcps, skills, catalogs]) => {
        if (!ativo) return;
        setContas({ mcps: mcps.items.length, skills: skills.total, catalogs: catalogs.items.length });
      })
      .catch((err) => ativo && toast.error((err as Error).message));
    return () => {
      ativo = false;
    };
  }, [toast]);

  return (
    <Panel title="O que é seu" icon={<Library />}>
      <p className="panel-hint">
        O que esta conta <strong>possui</strong> — é dona, não apenas vê. O que foi compartilhado
        com você não entra na conta.
      </p>
      {contas === null ? (
        <Skel h={72} />
      ) : (
        <div className="own-stats">
          <Tile to="/mcps?access=mine" value={contas.mcps} label="Servidores vMCP" icon={<Server />} />
          <Tile to="/my-space/skills" value={contas.skills} label="Skills" icon={<BookOpenCheck />} />
          <Tile to="/my-space/catalogs" value={contas.catalogs} label="Catálogos" icon={<Library />} />
        </div>
      )}
    </Panel>
  );
}

/** Um número do quadro; ele é link porque o próximo gesto de quem o lê é abrir a lista. */
function Tile({ to, value, label, icon }: { to: string; value: number; label: string; icon: ReactNode }) {
  return (
    <Link to={to} className="own-stat">
      <div className="v">{value}</div>
      <div className="k">
        {icon}
        {label}
      </div>
    </Link>
  );
}
