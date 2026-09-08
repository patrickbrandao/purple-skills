import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  children,
  variant = 'primary',
  size,
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button {...props} className={classes}>
      {children}
    </button>
  );
}

export function Panel({
  children,
  className = '',
  title,
  icon,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title && (
        <h2>
          {icon}
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Badge({ isPublic }: { isPublic: boolean }) {
  return (
    <span className={`badge ${isPublic ? 'public' : 'private'}`}>
      <span className="dot" />
      {isPublic ? 'pública' : 'privada'}
    </span>
  );
}

/**
 * As superfícies do MCP público, ao lado da visibilidade. Só leitura: quem liga
 * e desliga é o formulário de edição — aqui elas apenas informam, e numa skill
 * privada aparecem apagadas, porque a flag está guardada e não valendo
 * (`docs/06-publicacao-mcp.md` §3.1).
 *
 * `prompt` e `resource` aparecem quando **ligados**; a superfície de
 * ferramentas, ao contrário, aparece quando **desligada**. É o que informa: ela
 * nasce ligada, então um selo por skill flagada estaria em quase toda linha
 * sem dizer nada, enquanto a ausência é a exceção que o operador precisa ver.
 */
export function PublicationBadges({
  skill,
}: {
  skill: { isPublic: boolean; useAsSkill: boolean; useAsPrompt: boolean; useAsResource: boolean };
}) {
  const surfaces = [
    skill.useAsPrompt && 'prompt',
    skill.useAsResource && 'resource',
  ].filter((surface): surface is string => Boolean(surface));

  return (
    <>
      {!skill.useAsSkill && (
        <span
          className={`badge surface ${skill.isPublic ? 'off' : 'idle'}`}
          title={
            skill.isPublic
              ? 'Fora das ferramentas do MCP público: search_skills e get_skill não a encontram'
              : 'Ficará fora das ferramentas do MCP público quando a skill for tornada pública'
          }
        >
          sem ferramentas
        </span>
      )}

      {surfaces.map((surface) => (
        <span
          key={surface}
          className={`badge surface ${skill.isPublic ? '' : 'idle'}`.trim()}
          title={
            skill.isPublic
              ? `Publicada no MCP como ${surface}`
              : `Será publicada como ${surface} quando a skill for tornada pública`
          }
        >
          {surface}
        </span>
      ))}
    </>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-xs" style={{ color: 'var(--text-faint)' }}>
          {hint}
        </span>
      )}
    </label>
  );
}
