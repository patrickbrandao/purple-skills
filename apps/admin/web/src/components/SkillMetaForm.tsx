import { Field } from './ui.js';
import { SkillIcon } from './SkillIcon.js';
import { buildFrontmatter, parseTags } from '../frontmatter.js';

export type SkillMetaValues = {
  name: string;
  slug: string;
  description: string;
  tags: string;
  /** Emoji ou URL de imagem; vazio = monograma. */
  icon: string;
};

/**
 * Formulário dos metadados da skill. Estes campos são a **fonte da verdade**:
 * eles é que viram as primeiras linhas do SKILL.md (o frontmatter). O ícone
 * é do catálogo (cards e canvas), não do arquivo.
 */
export function SkillMetaForm({
  values,
  onChange,
  slugPlaceholder,
  slugRequired = true,
  nameRequired = true,
}: {
  values: SkillMetaValues;
  onChange: (patch: Partial<SkillMetaValues>) => void;
  slugPlaceholder?: string;
  slugRequired?: boolean;
  nameRequired?: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
          className="field"
          value={values.description}
          onChange={(event) => onChange({ description: event.target.value })}
          rows={3}
          placeholder="O que esta skill faz, em uma frase."
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Tags (separadas por vírgula)">
          <input
            className="field"
            value={values.tags}
            onChange={(event) => onChange({ tags: event.target.value })}
            placeholder="git, workflow, produtividade"
          />
        </Field>

        <Field label="Ícone" hint="Um emoji (🐘) ou a URL https de uma imagem. Vazio usa as iniciais.">
          <div className="flex items-center gap-2">
            <SkillIcon icon={values.icon.trim() || null} name={values.name || values.slug} slug={values.slug || values.name} />
            <input
              className="field"
              value={values.icon}
              onChange={(event) => onChange({ icon: event.target.value })}
              placeholder="🐘 ou https://…/logo.png"
              spellCheck={false}
            />
          </div>
        </Field>
      </div>
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
