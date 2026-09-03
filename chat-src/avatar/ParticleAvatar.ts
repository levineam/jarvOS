import { Application, Container, Particle, ParticleContainer, Texture } from 'pixi.js';
import {
  createAvatarModel,
  AVATAR_GESTURES,
  gesturePose,
  setAvatarState,
  setSpeechEnergy,
  smoothstep,
  stepAvatarModel,
  triggerGesture,
  type AvatarGesture,
  type AvatarModel,
  type AvatarState,
} from './model';
import {
  createParticleField,
  poseBodyParticle,
  type AmbientParticle,
  type BodyParticle,
} from './particle-field';

export interface AvatarController {
  setState(state: AvatarState): void;
  setSpeechEnergy(value: number): void;
  setReducedMotion(enabled: boolean): void;
  destroy(): void;
}

export type AvatarMetrics = {
  fps: number;
  frameTimeMs: number;
  particles: number;
  rendering: boolean;
  targetFps: number;
};

export type ParticleAvatarOptions = {
  initialState?: AvatarState;
  reducedMotion?: boolean;
  lowPerformance?: boolean;
  autoGestures?: boolean;
  onStateChange?: (state: AvatarState) => void;
};

type RuntimeBodyParticle = { display: Particle; spec: BodyParticle };
type RuntimeAmbientParticle = { display: Particle; spec: AmbientParticle };

const MODES = {
  normal: { body: 1450, ambient: 90, fps: 30 },
  low: { body: 500, ambient: 36, fps: 24 },
};

export class ParticleAvatar implements AvatarController {
  private readonly app = new Application();
  private readonly root = new Container();
  private readonly model: AvatarModel;
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityHandler = () => this.syncTicker();
  private texture?: Texture;
  private bodyContainer?: ParticleContainer;
  private mouthContainer?: ParticleContainer;
  private ambientContainer?: ParticleContainer;
  private bodyParticles: RuntimeBodyParticle[] = [];
  private mouthParticles: RuntimeBodyParticle[] = [];
  private ambientParticles: RuntimeAmbientParticle[] = [];
  private lowPerformance: boolean;
  private autoGestures: boolean;
  private gestureIndex = 0;
  private width = 460;
  private height = 560;
  private lastTick = performance.now();
  private frameTimeMs = 0;
  private initialized = false;
  private destroyed = false;
  private readonly onStateChange?: (state: AvatarState) => void;

  constructor(private readonly host: HTMLElement, options: ParticleAvatarOptions = {}) {
    this.lowPerformance = options.lowPerformance ?? false;
    this.autoGestures = options.autoGestures ?? true;
    this.model = createAvatarModel(options.initialState ?? 'hidden');
    this.model.reducedMotion = options.reducedMotion ?? false;
    this.onStateChange = options.onStateChange;
    this.resizeObserver = new ResizeObserver(() => this.resize());
  }

  async init(): Promise<this> {
    if (this.initialized || this.destroyed) return this;
    await this.app.init({
      antialias: false,
      autoDensity: true,
      autoStart: false,
      backgroundAlpha: 0,
      clearBeforeRender: true,
      powerPreference: 'low-power',
      preference: 'webgl',
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      width: this.host.clientWidth || 460,
      height: this.host.clientHeight || 560,
    });
    // destroy() may have won the race while Application.init() was pending.
    if (this.destroyed) {
      this.teardownRenderer();
      return this;
    }
    this.texture = createGlowTexture();
    this.app.canvas.className = 'avatar-canvas';
    this.app.canvas.setAttribute('aria-label', 'Abstract jarvOS point-light avatar');
    this.app.canvas.setAttribute('role', 'img');
    this.host.replaceChildren(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.initialized = true;
    this.rebuildField();
    this.resizeObserver.observe(this.host);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.app.ticker.add(this.tick);
    this.configureTicker();
    this.resize();
    this.syncTicker();
    return this;
  }

  setState(state: AvatarState): void {
    if (state === 'hidden') {
      setAvatarState(this.model, 'hidden');
      this.syncTicker();
      return;
    }
    if (this.model.targetState === 'hidden') {
      this.model.state = 'appearing';
      this.model.fromState = 'appearing';
      this.model.targetState = state;
      this.model.transition = 0;
      this.model.stateElapsed = 0;
    } else {
      setAvatarState(this.model, state);
    }
    this.syncTicker();
  }

  setSpeechEnergy(value: number): void {
    setSpeechEnergy(this.model, value);
  }

  setReducedMotion(enabled: boolean): void {
    this.model.reducedMotion = enabled;
    this.updateParticles();
  }

  setLowPerformance(enabled: boolean): void {
    if (enabled === this.lowPerformance) return;
    this.lowPerformance = enabled;
    this.configureTicker();
    this.rebuildField();
  }

  setAutoGestures(enabled: boolean): void {
    this.autoGestures = enabled;
  }

  triggerGestureNow(gesture: AvatarGesture): void {
    if (!this.model.reducedMotion) triggerGesture(this.model, gesture);
  }

  getMetrics(): AvatarMetrics {
    const mode = this.mode;
    return {
      fps: this.frameTimeMs ? 1000 / this.frameTimeMs : 0,
      frameTimeMs: this.frameTimeMs,
      particles: mode.body + mode.ambient,
      rendering: this.initialized && !!this.app.ticker?.started,
      targetFps: mode.fps,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.teardownRenderer();
  }

  private teardownRenderer(): void {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.resizeObserver.disconnect();
    this.app.ticker?.remove(this.tick);
    if (this.app.renderer) this.app.destroy({ removeView: true }, { children: true, texture: false });
    this.texture?.destroy(true);
    this.texture = undefined;
    this.host.replaceChildren();
    this.initialized = false;
  }

  private get mode() {
    return this.lowPerformance ? MODES.low : MODES.normal;
  }

  private readonly tick = (): void => {
    const now = performance.now();
    const delta = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.frameTimeMs += (delta * 1000 - this.frameTimeMs) * 0.1;
    const stateBeforeTick = this.model.targetState;
    stepAvatarModel(this.model, delta);
    this.maybeGesture();
    this.updateParticles();
    if (this.model.state === 'disappearing' && this.model.transition === 1) {
      setAvatarState(this.model, 'hidden');
      this.syncTicker();
    }
    if (this.model.targetState !== stateBeforeTick) this.onStateChange?.(this.model.targetState);
  };

  private rebuildField(): void {
    if (!this.texture) return;
    this.root.removeChildren().forEach((child) => child.destroy({ children: true }));
    const field = createParticleField({ bodyCount: this.mode.body, ambientCount: this.mode.ambient });
    this.bodyParticles = [];
    this.mouthParticles = [];
    this.ambientParticles = [];

    const body: Particle[] = [];
    const mouth: Particle[] = [];
    for (const spec of field.body) {
      const display = new Particle({
        texture: this.texture,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: spec.size,
        scaleY: spec.size,
        tint: spec.brightness > 0.87 ? 0xd7e7ff : spec.brightness > 0.62 ? 0x78a8ff : 0x2d68ed,
        alpha: spec.brightness,
      });
      const runtime = { display, spec };
      if (spec.bone === 'mouth') {
        mouth.push(display);
        this.mouthParticles.push(runtime);
      } else {
        body.push(display);
        this.bodyParticles.push(runtime);
      }
    }
    const ambient = field.ambient.map((spec) => {
      const display = new Particle({
        texture: this.texture!, anchorX: 0.5, anchorY: 0.5,
        scaleX: spec.size, scaleY: spec.size, tint: 0x4a83ff, alpha: spec.brightness,
      });
      this.ambientParticles.push({ display, spec });
      return display;
    });

    this.ambientContainer = particleContainer(ambient, this.texture, true);
    this.bodyContainer = particleContainer(body, this.texture, false);
    this.mouthContainer = particleContainer(mouth, this.texture, true);
    this.ambientContainer.blendMode = 'add';
    this.bodyContainer.blendMode = 'add';
    this.mouthContainer.blendMode = 'add';
    this.root.addChild(this.ambientContainer, this.bodyContainer, this.mouthContainer);
    this.updateParticles();
  }

  private updateParticles(): void {
    if (!this.initialized) return;
    const transition = smoothstep(this.model.transition);
    const appearing = stateWeight(this.model, 'appearing');
    const disappearing = stateWeight(this.model, 'disappearing');
    const thinking = stateWeight(this.model, 'thinking');
    const speaking = stateWeight(this.model, 'speaking');
    const interrupted = stateWeight(this.model, 'interrupted');
    const reveal = appearing ? transition : 1;
    const dissolve = disappearing ? transition : 0;
    const visibility = Math.max(0, Math.min(1, reveal * (1 - dissolve)));
    const scatter = appearing * (1 - transition) + disappearing * transition;
    const motion = this.model.reducedMotion ? 0.08 : Math.max(0.15, 1 - interrupted * 0.85);
    const gesture = this.model.gesture && !this.model.reducedMotion
      ? gesturePose(this.model.gesture, this.model.gestureElapsed / this.model.gestureDuration)
      : gesturePose(null, 0);
    const scale = Math.min(this.width / 460, this.height / 560);
    const offsetX = (this.width - 460 * scale) / 2;
    const offsetY = (this.height - 560 * scale) / 2;

    const position = ({ display, spec }: RuntimeBodyParticle) => {
      const posed = poseBodyParticle(spec, {
        elapsed: this.model.elapsed,
        speechEnergy: this.model.speechEnergy * speaking,
        gesture,
        motionAmount: motion,
        thinkingAmount: thinking,
      });
      const dispersedX = Math.cos(spec.scatterAngle + this.model.elapsed * 0.08) * spec.scatterDistance * scatter;
      const dispersedY = Math.sin(spec.scatterAngle + this.model.elapsed * 0.08) * spec.scatterDistance * scatter;
      display.x = offsetX + (posed.x + dispersedX) * 460 * scale;
      display.y = offsetY + (posed.y + dispersedY) * 560 * scale;
    };
    this.bodyParticles.forEach(position);
    this.mouthParticles.forEach((particle) => {
      position(particle);
      particle.display.alpha = Math.min(1, particle.spec.brightness * (0.8 + this.model.speechEnergy * speaking));
      particle.display.scaleX = particle.spec.size * (1 + this.model.speechEnergy * speaking * 0.18);
      particle.display.scaleY = particle.spec.size * (1 + this.model.speechEnergy * speaking * 0.18);
    });

    const pulse = this.model.reducedMotion ? 1 : 0.96 + Math.sin(this.model.elapsed * 1.5) * 0.04;
    if (this.bodyContainer) this.bodyContainer.alpha = visibility * pulse * (0.96 + thinking * 0.04);
    if (this.mouthContainer) this.mouthContainer.alpha = visibility;
    if (this.ambientContainer) this.ambientContainer.alpha = visibility * 0.58;
    this.ambientParticles.forEach(({ display, spec }) => {
      const drift = this.model.reducedMotion ? 0 : motion;
      display.x = spec.x * this.width + Math.sin(this.model.elapsed * spec.speed + spec.phase) * 12 * drift;
      display.y = spec.y * this.height + Math.cos(this.model.elapsed * spec.speed * 0.72 + spec.phase) * 8 * drift;
      display.alpha = spec.brightness * (0.7 + Math.sin(this.model.elapsed * 0.8 + spec.phase) * 0.2);
    });
  }

  private maybeGesture(): void {
    if (!this.autoGestures || this.model.reducedMotion || this.model.targetState !== 'speaking' || this.model.gesture || this.model.stateElapsed < this.model.nextGestureAt) return;
    triggerGesture(this.model, AVATAR_GESTURES[this.gestureIndex % AVATAR_GESTURES.length]);
    this.gestureIndex += 1;
    this.model.nextGestureAt = this.model.stateElapsed + 3.4 + ((this.gestureIndex * 1.37) % 2.6);
  }

  private configureTicker(): void {
    this.app.ticker.maxFPS = this.mode.fps;
    this.app.ticker.minFPS = 10;
  }

  private resize(): void {
    if (!this.initialized) return;
    this.width = Math.max(1, this.host.clientWidth || 460);
    this.height = Math.max(1, this.host.clientHeight || 560);
    this.app.renderer.resize(this.width, this.height);
    this.updateParticles();
  }

  private syncTicker(): void {
    if (!this.initialized) return;
    const shouldRender = this.model.targetState !== 'hidden' && !document.hidden;
    this.app.canvas.hidden = !shouldRender;
    if (shouldRender) {
      this.lastTick = performance.now();
      this.app.ticker.start();
    } else {
      this.app.ticker.stop();
      this.frameTimeMs = 0;
    }
  }
}

function particleContainer(particles: Particle[], texture: Texture, color: boolean) {
  const container = new ParticleContainer({
    particles,
    texture,
    dynamicProperties: { position: true, color, vertex: color, rotation: false },
  });
  container.update();
  return container;
}

function stateWeight(model: AvatarModel, state: AvatarState): number {
  if (model.transition === 1) return model.state === state ? 1 : 0;
  const amount = smoothstep(model.transition);
  if (model.targetState === state) return amount;
  if (model.fromState === state) return 1 - amount;
  return 0;
}

function createGlowTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  const gradient = context.createRadialGradient(12, 12, 0, 12, 12, 12);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.08, 'rgba(222,237,255,1)');
  gradient.addColorStop(0.24, 'rgba(103,158,255,.9)');
  gradient.addColorStop(0.52, 'rgba(37,99,255,.35)');
  gradient.addColorStop(1, 'rgba(15,55,220,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 24, 24);
  return Texture.from(canvas);
}
