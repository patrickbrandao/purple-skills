import { useId, type ReactNode } from 'react';
import { Bot } from 'lucide-react';
import { VIRTUAL_MCP_INSTRUCTIONS_MAX } from '../api.js';

/**
 * As `instructions` de um vMCP, apresentadas como a mensagem de sistema que
 * elas são (`docs/22`): o agente as recebe no `initialize`, depois do
 * texto-base do Purple Skills. O desenho imita uma mensagem de papel `system`
 * num transcript — rótulo em mono, corpo em mono — para não ser confundida
 * com a descrição, que é texto de gente para gente.
 */
function SystemHead({ extra }: { extra?: ReactNode }) {
  return (
    <div className="sysmsg-head">
      <span className="sysmsg-role">
        <Bot aria-hidden />
        system
      </span>
      <span className="sysmsg-where">enviada ao agente no initialize</span>
      {extra}
    </div>
  );
}

/** O editor: textarea dentro da moldura da mensagem, com o contador do teto. */
export function SystemMessageField({
  value,
  onChange,
  disabled,
  placeholder = 'You are connected to the skills of project X. Start with project-x-setup before editing any file…',
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  // Por code point, como o `char_length` do CHECK: `length` contaria um emoji
  // como dois e acusaria "a mais" num texto que o banco aceita.
  const usados = [...value.trim()].length;
  const restante = VIRTUAL_MCP_INSTRUCTIONS_MAX - usados;

  return (
    <div className="block">
      <label className="label" htmlFor={id}>
        Instruções (system message)
      </label>
      <div className={`sysmsg sysmsg-edit${restante < 0 ? ' sysmsg-over' : ''}`}>
        <SystemHead
          extra={
            <span className={`sysmsg-count${restante < 0 ? ' over' : ''}`}>
              {restante < 0 ? `${-restante} a mais` : `${usados}/${VIRTUAL_MCP_INSTRUCTIONS_MAX}`}
            </span>
          }
        />
        <textarea
          id={id}
          className="sysmsg-body"
          rows={6}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
        />
      </div>
      <span className="hint">
        Orienta o agente sobre este servidor: para que serve, por qual skill começar, o que evitar. Vai depois do
        texto-base do Purple Skills; escreva em inglês, que é o que o agente lê melhor. Clientes já conectados só a
        recebem ao reconectar.
      </span>
    </div>
  );
}

/** A leitura, para quem não edita (a gaveta do canvas). Vazia, diz o que acontece. */
export function SystemMessageView({ text }: { text: string }) {
  return (
    <div className="sysmsg">
      <SystemHead />
      {text ? (
        <p className="sysmsg-body">{text}</p>
      ) : (
        <p className="sysmsg-body sysmsg-empty">Sem instruções: o agente recebe só o texto-base do Purple Skills.</p>
      )}
    </div>
  );
}
