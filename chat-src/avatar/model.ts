export type AvatarState =
  | 'hidden'
  | 'appearing'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'disappearing';

export const AVATAR_GESTURES = ['outward', 'explain', 'emphasis', 'thoughtful'] as const;
export type AvatarGesture = typeof AVATAR_GESTURES[number];

export type GesturePose = {
  leftArm: number;
  rightArm: number;
  leftForearm: number;
  rightForearm: number;
  headTilt: number;
  shoulderTilt: number;
  torsoLean: number;
};

export type AvatarModel = {
  state: AvatarState;
  fromState: AvatarState;
  targetState: AvatarState;
  transition: number;
  elapsed: number;
  stateElapsed: number;
  speechEnergy: number;
  speechEnergyTarget: number;
  gesture: AvatarGesture | null;
  gestureElapsed: number;
  gestureDuration: number;
  nextGestureAt: number;
  reducedMotion: boolean;
};

const TRANSITION_SECONDS: Record<AvatarState, number> = {
  hidden: 0,
  appearing: 0.9,
  listening: 0.42,
  thinking: 0.55,
  speaking: 0.34,
  interrupted: 0.1,
  disappearing: 0.72,
};

const EMPTY_POSE: GesturePose = {
  leftArm: 0,
  rightArm: 0,
  leftForearm: 0,
  rightForearm: 0,
  headTilt: 0,
  shoulderTilt: 0,
  torsoLean: 0,
};

export function createAvatarModel(initialState: AvatarState = 'hidden'): AvatarModel {
  return {
    state: initialState,
    fromState: initialState,
    targetState: initialState,
    transition: 1,
    elapsed: 0,
    stateElapsed: 0,
    speechEnergy: 0,
    speechEnergyTarget: 0,
    gesture: null,
    gestureElapsed: 0,
    gestureDuration: 1.4,
    nextGestureAt: 3,
    reducedMotion: false,
  };
}

export function setAvatarState(model: AvatarModel, state: AvatarState): void {
  if (state === 'hidden') {
    model.state = 'hidden';
    model.fromState = 'hidden';
    model.targetState = 'hidden';
    model.transition = 1;
    model.stateElapsed = 0;
    model.gesture = null;
    model.speechEnergy = 0;
    model.speechEnergyTarget = 0;
    return;
  }
  if (state === model.targetState) return;
  model.fromState = model.transition === 1 ? model.state : model.targetState;
  model.targetState = state;
  model.transition = 0;
  model.stateElapsed = 0;
  if (state === 'interrupted') {
    model.gesture = null;
    model.speechEnergyTarget = 0;
  }
}

export function setSpeechEnergy(model: AvatarModel, value: number): void {
  model.speechEnergyTarget = clamp(value);
}

export function triggerGesture(model: AvatarModel, gesture: AvatarGesture): void {
  model.gesture = gesture;
  model.gestureElapsed = 0;
  model.gestureDuration = gesture === 'emphasis' ? 0.85 : gesture === 'thoughtful' ? 1.8 : 1.35;
}

export function stepAvatarModel(model: AvatarModel, deltaSeconds: number): void {
  if (model.state === 'hidden' && model.targetState === 'hidden') return;
  const delta = Math.min(0.1, Math.max(0, deltaSeconds));
  model.elapsed += delta;
  model.stateElapsed += delta;

  model.speechEnergyTarget = clamp(model.speechEnergyTarget);
  const response = model.speechEnergyTarget > model.speechEnergy ? 14 : 8;
  model.speechEnergy += (model.speechEnergyTarget - model.speechEnergy) * (1 - Math.exp(-response * delta));

  if (model.transition < 1) {
    const duration = TRANSITION_SECONDS[model.targetState];
    model.transition = duration ? Math.min(1, model.transition + delta / duration) : 1;
    if (model.transition === 1) {
      model.state = model.targetState;
      model.fromState = model.targetState;
    }
  }

  if (model.targetState === 'interrupted' && model.stateElapsed >= 0.28) {
    setAvatarState(model, 'listening');
  }

  if (model.gesture) {
    model.gestureElapsed += delta;
    if (model.gestureElapsed >= model.gestureDuration) model.gesture = null;
  }
}

export function gesturePose(gesture: AvatarGesture | null, progress: number): GesturePose {
  if (!gesture) return { ...EMPTY_POSE };
  const amount = Math.sin(Math.PI * clamp(progress));
  if (gesture === 'outward') {
    return { ...EMPTY_POSE, rightArm: -0.58 * amount, rightForearm: 0.38 * amount, torsoLean: -0.06 * amount };
  }
  if (gesture === 'explain') {
    return { ...EMPTY_POSE, leftArm: 0.38 * amount, rightArm: -0.38 * amount, leftForearm: -0.28 * amount, rightForearm: 0.28 * amount };
  }
  if (gesture === 'emphasis') {
    return { ...EMPTY_POSE, rightArm: -0.28 * amount, rightForearm: -0.62 * amount, torsoLean: 0.1 * amount };
  }
  return { ...EMPTY_POSE, headTilt: -0.34 * amount, shoulderTilt: -0.2 * amount, torsoLean: -0.08 * amount };
}

export function smoothstep(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
