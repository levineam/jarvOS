import type { GesturePose } from './model';

export type BoneName =
  | 'core' | 'torso' | 'head' | 'mouth'
  | 'upperArmL' | 'upperArmR' | 'lowerArmL' | 'lowerArmR'
  | 'handL' | 'handR' | 'thighL' | 'thighR' | 'shinL' | 'shinR';

export type BodyParticle = {
  bone: BoneName;
  x: number;
  y: number;
  size: number;
  brightness: number;
  phase: number;
  drift: number;
  scatterAngle: number;
  scatterDistance: number;
};

export type AmbientParticle = {
  x: number;
  y: number;
  size: number;
  brightness: number;
  phase: number;
  speed: number;
};

export type ParticleField = { body: BodyParticle[]; ambient: AmbientParticle[] };

export type PoseInput = {
  elapsed: number;
  speechEnergy: number;
  gesture?: GesturePose;
  motionAmount?: number;
  thinkingAmount?: number;
};

const REGIONS: Array<[BoneName, number]> = [
  ['core', 0.025], ['torso', 0.29], ['head', 0.145], ['mouth', 0.025],
  ['upperArmL', 0.055], ['upperArmR', 0.055], ['lowerArmL', 0.045], ['lowerArmR', 0.045],
  ['handL', 0.02], ['handR', 0.02], ['thighL', 0.075], ['thighR', 0.075],
  ['shinL', 0.065], ['shinR', 0.065],
];

const ZERO_GESTURE: GesturePose = {
  leftArm: 0, rightArm: 0, leftForearm: 0, rightForearm: 0,
  headTilt: 0, shoulderTilt: 0, torsoLean: 0,
};

export function createParticleField({ bodyCount, ambientCount, seed = 0x4a415256 }: {
  bodyCount: number;
  ambientCount: number;
  seed?: number;
}): ParticleField {
  const random = seededRandom(seed);
  const body = Array.from({ length: Math.max(0, Math.floor(bodyCount)) }, () => {
    const bone = chooseRegion(random());
    const point = sampleRegion(bone, random);
    return {
      bone,
      x: point.x,
      y: point.y,
      size: 0.18 + random() * random() * 0.42,
      brightness: 0.5 + random() * 0.5,
      phase: random() * Math.PI * 2,
      drift: 0.3 + random() * 0.7,
      scatterAngle: random() * Math.PI * 2,
      scatterDistance: 0.12 + random() * 0.48,
    } satisfies BodyParticle;
  });
  const ambient = Array.from({ length: Math.max(0, Math.floor(ambientCount)) }, () => ({
    x: 0.07 + random() * 0.86,
    y: 0.04 + random() * 0.92,
    size: 0.1 + random() * 0.22,
    brightness: 0.22 + random() * 0.48,
    phase: random() * Math.PI * 2,
    speed: 0.16 + random() * 0.38,
  }));
  return { body, ambient };
}

export function poseBodyParticle(particle: BodyParticle, input: PoseInput): { x: number; y: number } {
  const motion = input.motionAmount ?? 1;
  const thinking = input.thinkingAmount ?? 0;
  const gesture = input.gesture ?? ZERO_GESTURE;
  const breath = Math.sin(input.elapsed * 1.65) * 0.0045 * motion;
  const shimmer = Math.sin(input.elapsed * (0.7 + particle.drift) + particle.phase) * 0.0018 * motion;
  let point = { x: particle.x + shimmer, y: particle.y };

  if (particle.bone === 'torso' || particle.bone === 'core') {
    point = rotateAbout(point, { x: 0.5, y: 0.58 }, gesture.torsoLean * 0.22);
    point.x += gesture.shoulderTilt * (0.55 - point.y) * 0.08;
    point.y += breath * Math.max(0, (0.61 - point.y) / 0.3);
  }
  if (particle.bone === 'head' || particle.bone === 'mouth') {
    point = rotateAbout(point, { x: 0.5, y: 0.255 }, gesture.headTilt * 0.24 + Math.sin(input.elapsed * 0.42) * 0.052 * thinking);
    point.y += breath * 0.35;
  }
  if (particle.bone === 'mouth') {
    const energy = Math.min(1, Math.max(0, input.speechEnergy));
    point.y += energy * (0.009 + Math.abs(point.y - 0.298) * 0.22);
    point.x = 0.5 + (point.x - 0.5) * (1 + energy * 0.12);
  }
  if (particle.bone.endsWith('ArmL') || particle.bone === 'handL') {
    point = poseArm(point, 'left', particle.bone, gesture.leftArm, gesture.leftForearm, input.elapsed, motion);
  } else if (particle.bone.endsWith('ArmR') || particle.bone === 'handR') {
    point = poseArm(point, 'right', particle.bone, gesture.rightArm, gesture.rightForearm, input.elapsed, motion);
  }
  if (particle.bone.startsWith('thigh') || particle.bone.startsWith('shin')) {
    point.x += Math.sin(input.elapsed * 0.72 + particle.phase * 0.1) * 0.0017 * motion;
    point.y += breath * 0.18;
  }
  if (thinking) {
    const dx = point.x - 0.5;
    const dy = point.y - 0.47;
    const circulation = Math.sin(input.elapsed * 0.9 + particle.phase) * 0.0034 * thinking;
    point.x -= dy * circulation;
    point.y += dx * circulation;
  }
  return point;
}

function poseArm(point: { x: number; y: number }, side: 'left' | 'right', bone: BoneName, arm: number, forearm: number, elapsed: number, motion: number) {
  const sign = side === 'left' ? -1 : 1;
  const shoulder = { x: side === 'left' ? 0.395 : 0.605, y: 0.36 };
  const elbow = { x: side === 'left' ? 0.305 : 0.695, y: 0.505 };
  const upperRotation = sign * arm * 0.62 + sign * Math.sin(elapsed * 0.55) * 0.012 * motion;
  let posed = rotateAbout(point, shoulder, upperRotation);
  if (bone.startsWith('lowerArm') || bone.startsWith('hand')) {
    posed = rotateAbout(posed, rotateAbout(elbow, shoulder, upperRotation), sign * forearm * 0.72);
  }
  return posed;
}

function chooseRegion(value: number): BoneName {
  let total = 0;
  for (const [bone, weight] of REGIONS) {
    total += weight;
    if (value <= total) return bone;
  }
  return 'shinR';
}

function sampleRegion(bone: BoneName, random: () => number): { x: number; y: number } {
  switch (bone) {
    case 'core': return sampleEllipse(0.5, 0.585, 0.105, 0.065, random);
    case 'torso': return sampleTorso(random);
    case 'head': return sampleEllipse(0.5, 0.215, 0.09, 0.115, random);
    case 'mouth': return sampleEllipse(0.5, 0.292, 0.038, 0.018, random);
    case 'upperArmL': return sampleSegment(0.405, 0.355, 0.28, 0.5, 0.043, random);
    case 'upperArmR': return sampleSegment(0.595, 0.355, 0.72, 0.5, 0.043, random);
    case 'lowerArmL': return sampleSegment(0.28, 0.5, 0.15, 0.65, 0.035, random);
    case 'lowerArmR': return sampleSegment(0.72, 0.5, 0.85, 0.65, 0.035, random);
    case 'handL': return sampleEllipse(0.13, 0.672, 0.046, 0.05, random);
    case 'handR': return sampleEllipse(0.87, 0.672, 0.046, 0.05, random);
    case 'thighL': return sampleSegment(0.46, 0.59, 0.425, 0.765, 0.055, random);
    case 'thighR': return sampleSegment(0.54, 0.59, 0.575, 0.765, 0.055, random);
    case 'shinL': return sampleSegment(0.425, 0.765, 0.405, 0.915, 0.043, random);
    case 'shinR': return sampleSegment(0.575, 0.765, 0.595, 0.915, 0.043, random);
  }
}

function sampleTorso(random: () => number) {
  const y = 0.315 + random() * 0.3;
  const t = (y - 0.315) / 0.3;
  const halfWidth = 0.12 - t * 0.03 + Math.sin(t * Math.PI) * 0.018;
  return { x: 0.5 + (random() * 2 - 1) * halfWidth * Math.sqrt(random()), y };
}

function sampleEllipse(cx: number, cy: number, rx: number, ry: number, random: () => number) {
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(random());
  return { x: cx + Math.cos(angle) * rx * radius, y: cy + Math.sin(angle) * ry * radius };
}

function sampleSegment(sx: number, sy: number, ex: number, ey: number, width: number, random: () => number) {
  const along = random();
  const dx = ex - sx;
  const dy = ey - sy;
  const length = Math.hypot(dx, dy);
  const radial = (random() * 2 - 1) * width * (0.68 + Math.sin(along * Math.PI) * 0.32);
  return { x: sx + dx * along - (dy / length) * radial, y: sy + dy * along + (dx / length) * radial };
}

function rotateAbout(point: { x: number; y: number }, pivot: { x: number; y: number }, angle: number) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return { x: pivot.x + dx * cosine - dy * sine, y: pivot.y + dx * sine + dy * cosine };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
