import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type Anthropic from '@anthropic-ai/sdk';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { buildContextBlock, systemPrompt, type AssistantContext } from './context';
import type { ChatMessage } from './claude';
import { getApiKey, setApiKey, setPrefs, usePrefs } from '../store/prefs';
import { noteCounter } from '../store/activity';
import { formatNumber, formatQuantity } from '../engine/units';
import { getExperiment } from '../experiments/catalog';
import { KindBadge } from '../components/Provenance';

export type { AssistantContext };

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  error?: boolean;
}

const SUGGESTIONS = [
  'Explain the science behind this scenario.',
  'Which assumptions matter most for this result?',
  'Interpret my latest results.',
  'Compare my run with the baseline.',
  'What should I change next, and why?',
  'Explain the equations in simple terms.',
];

/** Minimal, safe Markdown renderer (no HTML): paragraphs, lists, **bold**, *italic*, `code`. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]);
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        if (/^#{1,4}\s/.test(lines[0])) {
          return (
            <Fragment key={i}>
              <h4>{inline(lines[0].replace(/^#+\s/, ''))}</h4>
              {lines.length > 1 && <p>{inline(lines.slice(1).join(' '))}</p>}
            </Fragment>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

/** Deterministic help built from the model's own documentation — available without AI. */
function BuiltInGuide({ ctx }: { ctx: AssistantContext }) {
  const m = ctx.model;
  if (!m) return <p className="muted">Open an experiment to see its built-in guide.</p>;
  const key = ctx.record ? m.summarize?.(ctx.record) ?? [] : [];
  const notEstablished = m.assumptions.filter((a) => a.kind !== 'established');
  return (
    <div className="guide">
      <p className="small muted">Built-in guide — generated from this model’s documentation and your recorded run. It is not AI.</p>
      <h4>What this model calculates</h4>
      <p>{m.summary}</p>
      <ul className="bullets small">
        {m.equations.slice(0, 4).map((e) => (
          <li key={e.label}>
            <strong>{e.label}:</strong> <code>{e.formula}</code>
          </li>
        ))}
      </ul>
      <h4>Assumptions that shape the result</h4>
      <ul className="assumptions small">
        {notEstablished.slice(0, 5).map((a, i) => (
          <li key={i}>
            <KindBadge kind={a.kind} /> {a.text}
          </li>
        ))}
      </ul>
      <h4>From your simulation</h4>
      {key.length ? (
        <ul className="bullets small">
          {key.map((k, i) => (
            <li key={i}>
              {k.label}: <span className="mono">{typeof k.value === 'number' ? (k.unit ? formatQuantity(k.value, k.unit, { sig: k.sig ?? 3 }) : formatNumber(k.value, 3)) : k.value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">Run the experiment to see results here.</p>
      )}
      <h4>Things to try</h4>
      <ol className="small">
        {m.education.guidedSteps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {ctx.experiment?.followUps && (
        <>
          <h4>Related experiments</h4>
          <ul className="bullets small">
            {ctx.experiment.followUps
              .map((id) => getExperiment(id))
              .filter(Boolean)
              .map((e) => (
                <li key={e!.id}>
                  <Link to={`/lab/${e!.id}`}>{e!.title}</Link>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

function KeySetup({ onDone }: { onDone: () => void }) {
  const prefs = usePrefs();
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(prefs.rememberKey);
  return (
    <form
      className="key-setup"
      onSubmit={(e) => {
        e.preventDefault();
        setApiKey(key.trim(), remember);
        setPrefs({ aiEnabled: true, rememberKey: remember });
        onDone();
      }}
    >
      <p>
        The assistant is optional. It sends your question, together with this experiment’s parameters and recorded results, from your browser directly to the Anthropic API using <strong>your own API key</strong>. Nothing is sent until you ask a question.
      </p>
      <label className="field">
        <span>Anthropic API key</span>
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" required />
      </label>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember the key on this device (otherwise it is forgotten when the tab closes)
      </label>
      <button className="btn primary" type="submit">
        Enable assistant
      </button>
    </form>
  );
}

export function AssistantPanel({ getContext, onClose }: { getContext: () => AssistantContext; onClose: () => void }) {
  const prefs = usePrefs();
  const [hasKey, setHasKey] = useState(() => !!getApiKey() && prefs.aiEnabled);
  const [mode, setMode] = useState<'chat' | 'guide'>(hasKey ? 'chat' : 'guide');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  useEffect(() => () => abort.current?.abort(), []);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    noteCounter('assistantQuestions');
    const context = buildContextBlock(getContext());
    const msg: ChatMessage = { role: 'user', content: [{ type: 'text', text: context }, { type: 'text', text: q }] };
    const pending = [...history.current, msg];
    setTurns((t) => [...t, { role: 'user', text: q }, { role: 'assistant', text: '' }]);
    abort.current = new AbortController();
    try {
      // The SDK is loaded on first use so experiments open without it.
      const { streamReply } = await import('./claude');
      const final = await streamReply({
        apiKey: getApiKey(),
        model: prefs.aiModel,
        system: systemPrompt(),
        messages: pending,
        signal: abort.current.signal,
        onText: (d) =>
          setTurns((t) => {
            const copy = [...t];
            copy[copy.length - 1] = { ...copy[copy.length - 1], text: copy[copy.length - 1].text + d };
            return copy;
          }),
      });
      // Append-only history: the exact content the model returned.
      history.current = [...pending, { role: 'assistant', content: final.content as unknown as Anthropic.Beta.BetaContentBlockParam[] }];
    } catch (err) {
      setTurns((t) => {
        const copy = [...t];
        copy[copy.length - 1] = { role: 'assistant', text: err instanceof Error ? err.message : String(err), error: true };
        return copy;
      });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const ctx = getContext();

  return (
    <aside className="assistant" aria-label="Scientific assistant">
      <header className="assistant-head">
        <div>
          <h2>
            <Icon name="assistant" /> Scientific assistant
          </h2>
          <div className="small muted">{hasKey ? `AI: ${prefs.aiModel} · uses your recorded data` : 'AI not configured'}</div>
        </div>
        <button className="btn-icon" onClick={onClose} aria-label="Close assistant">
          <Icon name="close" />
        </button>
      </header>
      <div className="segmented small assistant-mode" role="tablist">
        <button role="tab" aria-selected={mode === 'chat'} className={mode === 'chat' ? 'on' : ''} onClick={() => setMode('chat')}>
          Ask the AI
        </button>
        <button role="tab" aria-selected={mode === 'guide'} className={mode === 'guide' ? 'on' : ''} onClick={() => setMode('guide')}>
          Built-in guide
        </button>
      </div>
      <div className="assistant-body" ref={scrollRef}>
        {mode === 'guide' && <BuiltInGuide ctx={ctx} />}
        {mode === 'chat' && !hasKey && <KeySetup onDone={() => setHasKey(true)} />}
        {mode === 'chat' && hasKey && (
          <>
            {turns.length === 0 && (
              <div className="suggestions">
                <p className="small muted">The assistant sees this experiment’s model documentation, parameters and recorded results. It is instructed to separate established science, simulation results, estimates and speculation — still, check important claims.</p>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip link" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`turn turn-${t.role} ${t.error ? 'turn-error' : ''}`}>
                {t.role === 'assistant' ? t.text ? <Markdown text={t.text} /> : <span className="muted"><span className="spinner small" /> Thinking…</span> : <p>{t.text}</p>}
              </div>
            ))}
          </>
        )}
      </div>
      {mode === 'chat' && hasKey && (
        <form
          className="assistant-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask about this experiment…"
            rows={2}
            aria-label="Message"
          />
          {busy ? (
            <button type="button" className="btn secondary" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!input.trim()}>
              Send
            </button>
          )}
        </form>
      )}
    </aside>
  );
}
