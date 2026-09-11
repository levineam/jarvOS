import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import './styles.css';

const VoiceAvatarPanel = lazy(() => import('./VoiceAvatarPanel').then(({ VoiceAvatarPanel }) => ({ default: VoiceAvatarPanel })));

type ModelInfo = {
  id: string;
  label: string;
  reasoningEfforts: string[];
};

type Settings = {
  hasKey: boolean;
  source: string;
  canStoreKey: boolean;
  subscription?: {
    available: boolean;
    authenticated: boolean;
    connection: string;
    planType?: string | null;
    requiresSignIn?: boolean;
    reason?: string;
  };
  voice?: { available: boolean };
};

function api<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, init).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `${path} failed`);
    return data;
  });
}

function partText(part: any) {
  if (part.type === 'text') return part.text || '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

// Render assistant markdown using the marked + DOMPurify globals already loaded
// on the page (same pipeline the rest of the app uses in static/app.js). Returns
// sanitized HTML, or '' if the libs are unavailable so callers can fall back to
// plain text.
function renderMarkdown(text: string): string {
  const marked = (window as any).marked;
  const DOMPurify = (window as any).DOMPurify;
  if (!marked || !DOMPurify) return '';
  const parse = typeof marked.parse === 'function' ? marked.parse : marked;
  // Assistant output can carry prompt-injected content (the agent reads local
  // notes, memory, source, and logs). Forbid every tag/attr that auto-loads a
  // remote resource, so a rendered message can never silently beacon data out
  // via an image/media/CSS fetch. Text, links, code, and tables still render.
  return DOMPurify.sanitize(parse(text, { mangle: false, headerIds: false }), {
    FORBID_TAGS: [
      'img', 'picture', 'source', 'svg', 'math', 'iframe', 'frame',
      'object', 'embed', 'video', 'audio', 'track', 'style', 'link',
      'form', 'input', 'button', 'base', 'meta',
    ],
    FORBID_ATTR: [
      'src', 'srcset', 'poster', 'background', 'style', 'ping',
      'formaction', 'action', 'lowsrc', 'dynsrc',
    ],
  });
}

// Assistant text is markdown; user text is shown verbatim. React escapes the
// plain-text branch, and DOMPurify sanitizes the markdown branch.
function MessageText({ text, role }: { text: string; role: string }) {
  if (role === 'assistant') {
    const html = renderMarkdown(text);
    if (html) return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <p>{text}</p>;
}

function ActivityPart({ part, onApprove, onDeny }: { part: any; onApprove: (id: string) => void; onDeny: (id: string) => void }) {
  if (!String(part.type || '').startsWith('tool-')) return null;
  const name = part.type.replace(/^tool-/, '').replace(/_/g, ' ');
  const input = part.input ?? part.args ?? {};
  const output = part.output ?? part.result;
  const approvalId = part.approval?.id;
  return (
    <details className={`activity-card state-${part.state || 'pending'}`} open={part.state === 'approval-requested'}>
      <summary>
        <span>{name}</span>
        <b>{String(part.state || 'running').replace(/-/g, ' ')}</b>
      </summary>
      {Object.keys(input).length > 0 && <pre>{JSON.stringify(input, null, 2)}</pre>}
      {part.state === 'approval-requested' && approvalId && (
        <div className="approval-actions">
          <button type="button" onClick={() => onApprove(approvalId)}>Approve</button>
          <button type="button" className="quiet" onClick={() => onDeny(approvalId)}>Discard</button>
        </div>
      )}
      {output !== undefined && <pre>{typeof output === 'string' ? output : JSON.stringify(output, null, 2)}</pre>}
    </details>
  );
}

function RightPanel({ pending, onApprove, onDeny }: { pending: any[]; onApprove: (id: string) => void; onDeny: (id: string) => void }) {
  const item = pending[0];
  return (
    <aside className={`chat-panel ${item ? 'open' : ''}`}>
      {item ? (
        <>
          <div className="panel-kicker">Approval</div>
          <h2>{item.type.replace(/^tool-/, '').replace(/_/g, ' ')}</h2>
          <pre>{JSON.stringify(item.input ?? item.args ?? {}, null, 2)}</pre>
          <div className="approval-actions">
            <button type="button" onClick={() => onApprove(item.approval.id)}>Approve</button>
            <button type="button" className="quiet" onClick={() => onDeny(item.approval.id)}>Discard</button>
          </div>
        </>
      ) : (
        <>
          <div className="panel-kicker">Workspace</div>
          <h2>No artifact pending</h2>
          <p>Drafts, issue payloads, and dispatch requests appear here when the agent asks for approval.</p>
        </>
      )}
    </aside>
  );
}

function SettingsBar({ settings, connection, onConnection, onSaved }: {
  settings: Settings | null;
  connection: 'subscription' | 'api-key';
  onConnection: (connection: 'subscription' | 'api-key') => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  async function save() {
    setError('');
    try {
      await api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiKey: key }),
      });
      setKey('');
      setOpen(false);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function clear() {
    await api('/api/settings', { method: 'DELETE' });
    onSaved();
  }

  return (
    <div className="settings-bar">
      <span className={(connection === 'subscription' ? settings?.subscription?.authenticated : settings?.hasKey) ? 'dot ok' : 'dot warn'} />
      <span>{connection === 'subscription'
        ? settings?.subscription?.authenticated ? `ChatGPT ${settings.subscription.planType || 'subscription'}` : 'ChatGPT sign-in required'
        : settings?.hasKey ? `API key: ${settings.source}` : 'API key required'}</span>
      <button type="button" className="icon-btn" onClick={() => setOpen(!open)} aria-label="Open settings">⚙</button>
      {open && (
        <div className="settings-popover">
          <div className="connection-choice" role="group" aria-label="Chat connection">
            <button type="button" className={connection === 'subscription' ? 'active' : ''} onClick={() => onConnection('subscription')}>ChatGPT subscription</button>
            <button type="button" className={connection === 'api-key' ? 'active' : ''} onClick={() => onConnection('api-key')}>API key</button>
          </div>
          {connection === 'subscription' ? (
            <p>{settings?.subscription?.authenticated
              ? 'Uses the ChatGPT account already signed in to Codex. Ordinary chat is text-only and has no workspace tools.'
              : settings?.subscription?.reason || 'Sign in with ChatGPT through Codex on this Mac, then reopen Chat.'}</p>
          ) : settings?.canStoreKey ? (
            <><input value={key} onChange={(e) => setKey(e.target.value)} placeholder="OpenAI API key" type="password" /><button type="button" onClick={save}>Save</button></>
          ) : <p>Set OPENAI_API_KEY before starting the server, or run the Electron app to store a key in the OS keychain.</p>}
          {connection === 'api-key' && settings?.hasKey && settings.source !== 'env' && <button type="button" className="quiet" onClick={clear}>Clear key</button>}
          {error && <div className="chat-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

function ChatApp() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('medium');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [connection, setConnection] = useState<'subscription' | 'api-key'>('subscription');
  const [conversationId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState('');
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [voiceError, setVoiceError] = useState('');
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const requestOptions = useRef({ modelId, reasoningEffort, connection, conversationId });
  requestOptions.current = { modelId, reasoningEffort, connection, conversationId };

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/chat',
    body: () => requestOptions.current,
  }), []);

  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    addToolApprovalResponse,
  } = useChat({ transport });

  async function refreshSettings() {
    setSettings(await api<Settings>('/api/settings'));
  }

  useEffect(() => {
    let current = true;
    setModels([]);
    setModelId('');
    api<{ models: ModelInfo[]; defaultModelId: string; defaultReasoningEffort: string }>(`/api/chat/models?connection=${connection}`).then((data) => {
      if (!current) return;
      setModels(data.models);
      setModelId(data.defaultModelId);
      setReasoningEffort(data.defaultReasoningEffort);
    }).catch(() => { if (current) setModelId(''); });
    return () => { current = false; };
  }, [connection]);

  useEffect(() => {
    refreshSettings();
  }, []);

  const chatReady = connection === 'subscription' ? settings?.subscription?.authenticated : settings?.hasKey;

  const pendingApprovals = messages.flatMap((message: any) =>
    (message.parts || []).filter((part: any) => String(part.type).startsWith('tool-') && part.state === 'approval-requested' && part.approval?.id));

  function approve(id: string, approved = true) {
    addToolApprovalResponse({ id, approved });
    sendMessage();
  }

  function submit() {
    const text = input.trim();
    if (!text || status === 'streaming' || status === 'submitted') return;
    setInput('');
    sendMessage({ text });
  }

  async function toggleMic() {
    if (voiceState === 'recording' && recorder) {
      recorder.stop();
      return;
    }
    if (!settings?.voice?.available) return;
    setAvatarOpen(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      // Denied/unavailable mic: surface it instead of leaving an unhandled rejection.
      setVoiceError(err?.message || 'Microphone unavailable');
      setVoiceState('idle');
      return;
    }
    setVoiceError('');
    const chunks: Blob[] = [];
    const next = new MediaRecorder(stream);
    next.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    next.onstop = async () => {
      setVoiceState('working');
      stream.getTracks().forEach((track) => track.stop());
      try {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const data = await api<{ text: string }>('/api/transcribe', { method: 'POST', body: blob });
        setInput((current) => [current, data.text].filter(Boolean).join(' ').trim());
      } catch (err: any) {
        setVoiceError(err?.message || 'Transcription failed');
      } finally {
        setVoiceState('idle');
      }
    };
    setRecorder(next);
    setVoiceState('recording');
    next.start();
  }

  return (
    <div className="chat-shell">
      <section className="chat-main">
        <header className="chat-head">
          <div>
            <div className="page-kicker">agentic desktop</div>
            <h1>Chat</h1>
          </div>
          <div className="chat-head-actions">
            <button type="button" className="avatar-launch" onClick={() => setAvatarOpen(true)}><i />Voice avatar</button>
            <SettingsBar settings={settings} connection={connection} onConnection={setConnection} onSaved={refreshSettings} />
          </div>
        </header>

        {!chatReady && (
          <div className="no-key">
            <h2>{connection === 'subscription' ? 'Sign in with ChatGPT to start chatting' : 'Add an OpenAI key to start chatting'}</h2>
            <p>{connection === 'subscription'
              ? 'Desktop reuses the ChatGPT account managed by Codex. It never reads or copies your credential.'
              : 'API-key billing is used only while this connection is explicitly selected.'}</p>
          </div>
        )}

        <div className="thread">
          {messages.length === 0 && <div className="empty-chat">{connection === 'subscription'
            ? 'Start a private text conversation through your ChatGPT subscription. Workspace tools are off.'
            : 'Ask about your journal, notes, memory, ontology, or Paperclip work.'}</div>}
          {messages.map((message: any) => (
            <article className={`msg ${message.role}`} key={message.id}>
              <div className="msg-body">
                {(message.parts || []).map((part: any, index: number) => {
                  const text = partText(part);
                  if (text) return <MessageText key={index} text={text} role={message.role} />;
                  return <ActivityPart key={index} part={part} onApprove={(id) => approve(id, true)} onDeny={(id) => approve(id, false)} />;
                })}
              </div>
            </article>
          ))}
          {error && <div className="chat-error">{error.message}</div>}
        </div>

        <footer className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask jarvOS…"
            rows={1}
          />
          <div className="composer-bar">
            <div className="composer-controls">
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              <select value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value)} aria-label="Thinking level">
                {(models.find((model) => model.id === modelId)?.reasoningEfforts || ['minimal', 'low', 'medium', 'high']).map((effort) => <option key={effort} value={effort}>thinking: {effort}</option>)}
              </select>
            </div>
            <div className="composer-actions">
              <button type="button" className="icon-btn round" disabled={!settings?.voice?.available || voiceState === 'working'} onClick={toggleMic} aria-label={settings?.voice?.available ? 'Dictate' : 'Voice unavailable'} title={settings?.voice?.available ? 'Dictate' : 'Voice unavailable'}>
                {voiceState === 'recording' ? '■' : '◉'}
              </button>
              {status === 'streaming' || status === 'submitted'
                ? <button type="button" className="send-btn" onClick={stop} aria-label="Stop">■</button>
                : <button type="button" className="send-btn" disabled={!chatReady || !modelId || !input.trim()} onClick={submit} aria-label="Send">↑</button>}
            </div>
          </div>
          {voiceError && <div className="chat-error">{voiceError}</div>}
        </footer>
      </section>
      <RightPanel pending={pendingApprovals} onApprove={(id) => approve(id, true)} onDeny={(id) => approve(id, false)} />
      {avatarOpen && (
        <Suspense fallback={null}>
          <VoiceAvatarPanel voiceState={voiceState} onClose={() => setAvatarOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

declare global {
  interface Window {
    mountJarvosChat?: () => void;
    unmountJarvosChat?: () => void;
  }
}

let root: Root | null = null;
let rootTarget: HTMLElement | null = null;

window.mountJarvosChat = function mountJarvosChat() {
  const rootEl = document.getElementById('chat-root');
  if (!rootEl) return;
  if (rootTarget !== rootEl) {
    root = createRoot(rootEl);
    rootTarget = rootEl;
  }
  root?.render(<ChatApp />);
};

window.unmountJarvosChat = function unmountJarvosChat() {
  if (root) {
    root.unmount();
  }
  root = null;
  rootTarget = null;
};

if (document.getElementById('chat-root')) {
  window.mountJarvosChat();
}
