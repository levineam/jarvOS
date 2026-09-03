import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ParticleAvatar, type AvatarGesture, type AvatarMetrics, type AvatarState } from './avatar';
import { AVATAR_GESTURES } from './avatar/model';

const STATES: AvatarState[] = ['appearing', 'listening', 'thinking', 'speaking', 'interrupted', 'disappearing', 'hidden'];

export function VoiceAvatarPanel({ onClose, voiceState }: {
  onClose: () => void;
  voiceState: 'idle' | 'recording' | 'working';
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<ParticleAvatar | null>(null);
  const [state, setState] = useState<AvatarState>(voiceState === 'working' ? 'thinking' : 'listening');
  const [speechEnergy, setSpeechEnergy] = useState(0.42);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [lowPerformance, setLowPerformance] = useState(false);
  const [autoGestures, setAutoGestures] = useState(true);
  const [metrics, setMetrics] = useState<AvatarMetrics | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const controlsRef = useRef({ speechEnergy, reducedMotion, lowPerformance, autoGestures });
  const stateRef = useRef(state);
  const stateVersionRef = useRef(0);
  const introTimerRef = useRef(0);
  controlsRef.current = { speechEnergy, reducedMotion, lowPerformance, autoGestures };

  useEffect(() => {
    if (!stageRef.current) return;
    const avatar = new ParticleAvatar(stageRef.current, {
      reducedMotion,
      lowPerformance,
      autoGestures,
      onStateChange: syncRendererState,
    });
    let disposed = false;
    let initialized = false;
    let metricsTimer = 0;
    const updateMetrics = () => {
      const next = avatar.getMetrics();
      setMetrics((current) => current && metricsEqual(current, next) ? current : next);
    };
    const destroyAvatar = () => {
      if (!initialized) return;
      if (avatarRef.current === avatar) avatarRef.current = null;
      avatar.destroy();
    };
    avatar.init().then(() => {
      initialized = true;
      if (disposed) return avatar.destroy();
      avatarRef.current = avatar;
      syncControls(avatar);
      const settleState = stateRef.current;
      const introVersion = stateVersionRef.current;
      chooseState('appearing', false);
      introTimerRef.current = window.setTimeout(() => {
        if (stateVersionRef.current === introVersion) chooseState(settleState, false);
      }, 950);
      updateMetrics();
      metricsTimer = window.setInterval(updateMetrics, 350);
    }).catch(() => {
      initialized = true;
      destroyAvatar();
      if (!disposed) {
        setUnavailable(true);
        setMetrics(null);
      }
    });
    return () => {
      disposed = true;
      window.clearTimeout(introTimerRef.current);
      window.clearInterval(metricsTimer);
      destroyAvatar();
    };
  }, []);

  useEffect(() => {
    if (voiceState === 'recording') chooseState('listening');
    if (voiceState === 'working') chooseState('thinking');
  }, [voiceState]);

  useEffect(() => avatarRef.current?.setSpeechEnergy(speechEnergy), [speechEnergy]);
  useEffect(() => avatarRef.current?.setReducedMotion(reducedMotion), [reducedMotion]);
  useEffect(() => avatarRef.current?.setLowPerformance(lowPerformance), [lowPerformance]);
  useEffect(() => avatarRef.current?.setAutoGestures(autoGestures), [autoGestures]);

  function syncControls(avatar: ParticleAvatar) {
    const controls = controlsRef.current;
    avatar.setSpeechEnergy(controls.speechEnergy);
    avatar.setReducedMotion(controls.reducedMotion);
    avatar.setLowPerformance(controls.lowPerformance);
    avatar.setAutoGestures(controls.autoGestures);
  }

  function chooseState(next: AvatarState, userOrVoiceChange = true) {
    if (userOrVoiceChange) {
      stateVersionRef.current += 1;
      window.clearTimeout(introTimerRef.current);
    }
    stateRef.current = next;
    setState(next);
    avatarRef.current?.setState(next);
    if (next === 'speaking') {
      avatarRef.current?.setSpeechEnergy(controlsRef.current.speechEnergy);
    }
  }

  function syncRendererState(next: AvatarState) {
    stateRef.current = next;
    setState(next);
  }

  return createPortal(
    <div className="avatar-backdrop" role="dialog" aria-modal="true" aria-labelledby="avatar-title">
      <section className="avatar-lab">
        <header className="avatar-lab-head">
          <div>
            <div className="page-kicker">voice mode prototype</div>
            <h2 id="avatar-title">Particle presence</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close voice avatar">×</button>
        </header>

        <div className="avatar-demo-grid">
          <div className="avatar-viewport" data-avatar-state={state} data-rendering={metrics?.rendering ?? false}>
            <div ref={stageRef} className="avatar-stage" />
            <div className="avatar-state-readout"><i />{state}</div>
            <div className="avatar-metrics">
              {unavailable
                ? 'Avatar unavailable'
                : metrics?.rendering
                ? `${metrics.fps.toFixed(0)} fps · ${metrics.frameTimeMs.toFixed(1)} ms · ${metrics.particles} lights`
                : `Paused · 0 render work · ${metrics?.particles ?? 0} lights`}
            </div>
          </div>

          <aside className="avatar-controls">
            <ControlGroup label="State">
              <div className="avatar-button-grid">
                {STATES.map((item) => (
                  <button type="button" key={item} className={state === item ? 'active' : ''} onClick={() => chooseState(item)}>{item}</button>
                ))}
              </div>
            </ControlGroup>

            <ControlGroup label="Speech energy">
              <label className="avatar-range">
                <input type="range" min="0" max="1" step="0.01" value={speechEnergy} onChange={(event) => setSpeechEnergy(Number(event.target.value))} />
                <output>{speechEnergy.toFixed(2)}</output>
              </label>
            </ControlGroup>

            <ControlGroup label="Gestures">
              <div className="avatar-button-grid gestures">
                {AVATAR_GESTURES.map((gesture: AvatarGesture) => (
                  <button type="button" key={gesture} onClick={() => avatarRef.current?.triggerGestureNow(gesture)}>{gesture}</button>
                ))}
              </div>
            </ControlGroup>

            <ControlGroup label="Performance">
              <Toggle label="Reduced motion" checked={reducedMotion} onChange={setReducedMotion} />
              <Toggle label="Low performance" checked={lowPerformance} onChange={setLowPerformance} />
              <Toggle label="Automatic gestures" checked={autoGestures} onChange={setAutoGestures} />
            </ControlGroup>
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <fieldset className="avatar-control-group"><legend>{label}</legend>{children}</fieldset>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="avatar-toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function metricsEqual(left: AvatarMetrics, right: AvatarMetrics) {
  return left.fps === right.fps && left.frameTimeMs === right.frameTimeMs && left.particles === right.particles
    && left.rendering === right.rendering && left.targetFps === right.targetFps;
}
