import { Field } from './ui.js';
import { buildFrontmatter, parseTags } from '../frontmatter.js';

export type SkillMetaValues = {
  name: string;
  slug: string;
  description: string;
  tags: string;
  isPublic: boolean;
  useAsPrompt: boolean;
  useAsResource: boolean;
};

/**
 * Formulário dos metadados da skill.
 *
 * Estes campos são a **fonte da verdade**: eles é que viram as primeiras
 * linhas do SKILL.md (o frontmatter). Por isso ficam na mesma tela do prompt,
 * acima dele — e não numa aba separada, onde seria fácil salvar um prompt com
 * metadados contraditórios.
 */
export function SkillMetaForm({
  values,
  onChange,
  slugPlaceholder,
  slugRequired = true,
  nameRequired = true,
  publicLabel = 'Skill pública — visível no site, na API e no MCP público',
}: {
  values: SkillMetaValues;
  onChange: (patch: Partial<SkillMetaValues>) => void;
  slugPlaceholder?: string;
  slugRequired?: boolean;
  nameRequired?: boolean;
  publicLabel?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Slug — nome oficial da skill" hint="Identifica a skill no name: do SKILL.md, na URL e nas ferramentas MCP. Só minúsculas, números e hífen.">
          <input
            className="field field-mono"
            value={values.slug}
            onChange={(event) => onChange({ slug: event.target.value })}
            placeholder={slugPlaceholder}
            required={slugRequired}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Field>

        <Field label="Nome de exibição" hint="Como a skill aparece no catálogo. Aceita maiúsculas, acentos e espaços.">
          <input
            className="field"
            value={values.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="Conventional Commits"
            required={nameRequired}
          />
        </Field>
      </div>

      <Field label="Descrição" hint="Diz o que a skill faz e quando usá-la — é por ela que o agente decide acionar a skill.">
        <textarea
          className="field resize-y"
          value={values.description}
          onChange={(event) => onChange({ description: event.target.value })}
          rows={3}
          placeholder="O que esta skill faz, em uma frase."
        />
      </Field>

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field label="Tags (separadas por vírgula)">
          <input
            className="field"
            value={values.tags}
            onChange={(event) => onChange({ tags: event.target.value })}
            placeholder="git, workflow, produtividade"
          />
        </Field>

        <label
          className="flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3 sm:mt-[1.85rem]"
          style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }}
        >
          <input
            type="checkbox"
            checked={values.isPublic}
            onChange={(event) => onChange({ isPublic: event.target.checked })}
            className="h-4 w-4"
          />
          <span className="text-sm">{publicLabel}</span>
        </label>
      </div>

      <PublicationFlags values={values} onChange={onChange} />
    </div>
  );
}

/**
 * Como a skill é oferecida no MCP público, além das ferramentas.
 *
 * Continuam editáveis numa skill privada de propósito: desabilitá-los obrigaria
 * a salvar duas vezes — publicar e depois flagar — e apagaria da tela a
 * intenção de quem está preparando uma skill para lançar. O aviso abaixo diz
 * que, sem "pública", nada disso aparece.
 */
function PublicationFlags({
  values,
  onChange,
}: {
  values: SkillMetaValues;
  onChange: (patch: Partial<SkillMetaValues>) => void;
}) {
  const opcoes = [
    {
      key: 'useAsPrompt' as const,
      titulo: 'Publicar como prompt',
      hint: (
        <>
          O cliente lista a skill em <code>prompts/list</code> pelo slug — na maioria deles, um
          slash-command que o usuário invoca direto.
        </>
      ),
    },
    {
      key: 'useAsResource' as const,
      titulo: 'Publicar como resource',
      hint: (
        <>
          A skill ganha um endereço estável, <code>skill://{values.slug || '<slug>'}</code>, que o
          agente lê e referencia como qualquer outro documento.
        </>
      ),
    },
  ];

  return (
    <div>
      <span className="label">Publicação no MCP público</span>
      <div className="grid gap-3 sm:grid-cols-2">
        {opcoes.map((opcao) => (
          <label
            key={opcao.key}
            className="flex cursor-pointer items-start gap-3 rounded-xl px-3.5 py-3"
            style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }}
          >
            <input
              type="checkbox"
              checked={values[opcao.key]}
              onChange={(event) => onChange({ [opcao.key]: event.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-sm">{opcao.titulo}</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
                {opcao.hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      {!values.isPublic && (values.useAsPrompt || values.useAsResource) && (
        <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          A skill está privada: nada disso aparece no MCP até que ela seja publicada. A
          configuração fica guardada para quando isso acontecer.
        </p>
      )}
    </div>
  );
}

/** Pré-visualização das primeiras linhas geradas a partir do formulário. */
export function FrontmatterPreview({ values }: { values: SkillMetaValues }) {
  const yaml = buildFrontmatter({
    // Sem slug ainda: mostra o lugar dele em vez de um nome que não existe.
    slug: values.slug || '<slug>',
    name: values.name,
    description: values.description,
    tags: parseTags(values.tags),
  });

  return (
    <div className="fm-preview">
      <span className="t">Primeiras linhas do SKILL.md, geradas destes campos</span>
      <pre>{yaml}</pre>
    </div>
  );
}
