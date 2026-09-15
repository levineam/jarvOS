export type BodyParticle = {
  x: number;
  y: number;
  size: number;
  brightness: number;
  edgeAlpha: number;
  phase: number;
  drift: number;
  scatterAngle: number;
  scatterDistance: number;
};

export type AmbientParticle = { x: number; y: number; size: number; brightness: number; phase: number; speed: number };
export type ParticleField = { body: BodyParticle[]; ambient: AmbientParticle[] };
export type PoseInput = { elapsed: number; motionAmount?: number };
export type LuminanceInput = { elapsed?: number; speechEnergy?: number; equalBrightness?: boolean };

export function avatarEnvelope(x: number, y: number): number {
  const headRadius = Math.hypot((x - 0.5) / 0.19, (y - 0.3) / 0.235);
  const head = softInside(headRadius, 0.78, 1.18);
  const neckRadius = Math.hypot((x - 0.5) / 0.115, (y - 0.515) / 0.14);
  const neck = softInside(neckRadius, 0.65, 1.24) * smoothstep(0.41, 0.55, y);
  const shoulderRadius = Math.pow(Math.abs((x - 0.5) / 0.43), 3.2) + Math.pow(Math.abs((y - 0.685) / 0.17), 3.2);
  const shoulders = softInside(shoulderRadius, 0.38, 1.28) * smoothstep(0.48, 0.61, y);
  return Math.max(head, neck * 0.92, shoulders * 0.9);
}

export function createParticleField({ bodyCount, ambientCount, seed = 0x4a415256 }: { bodyCount: number; ambientCount: number; seed?: number }): ParticleField {
  const random = seededRandom(seed);
  const body: BodyParticle[] = [];
  const target = Math.max(0, Math.floor(bodyCount));
  const minimumDistance = target > 900 ? 0.008 : 0.012;
  const cells = new Map<string, BodyParticle[]>();
  const nearbyDistance = (x: number, y: number) => {
    const cellX = Math.floor(x / minimumDistance);
    const cellY = Math.floor(y / minimumDistance);
    let nearest = Infinity;
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (const particle of cells.get(`${cellX + offsetX}:${cellY + offsetY}`) || []) {
          nearest = Math.min(nearest, Math.hypot(x - particle.x, y - particle.y));
        }
      }
    }
    return nearest;
  };
  for (let index = 0; index < target; index += 1) {
    let chosen = { x: 0.5, y: 0.4, edgeAlpha: 1 };
    let bestDistance = -1;
    for (let attempt = 0; attempt < 72; attempt += 1) {
      const x = 0.035 + random() * 0.93;
      const y = 0.025 + random() * 0.85;
      const edgeAlpha = avatarEnvelope(x, y);
      if (random() > 0.12 + edgeAlpha * 0.88) continue;
      const nearest = nearbyDistance(x, y);
      if (nearest > bestDistance) { bestDistance = nearest; chosen = { x, y, edgeAlpha }; }
      if (nearest >= minimumDistance) break;
    }
    const particle = {
      ...chosen,
      size: 0.24 + random() * 0.1,
      brightness: 0.68 + random() * 0.25,
      phase: random() * Math.PI * 2,
      drift: 0.35 + random() * 0.65,
      scatterAngle: random() * Math.PI * 2,
      scatterDistance: 0.12 + random() * 0.48,
    };
    body.push(particle);
    const key = `${Math.floor(particle.x / minimumDistance)}:${Math.floor(particle.y / minimumDistance)}`;
    const bucket = cells.get(key) || [];
    bucket.push(particle);
    cells.set(key, bucket);
  }
  const ambient = Array.from({ length: Math.max(0, Math.floor(ambientCount)) }, () => ({
    x: 0.04 + random() * 0.92, y: 0.03 + random() * 0.91,
    size: 0.13 + random() * 0.1, brightness: 0.16 + random() * 0.25,
    phase: random() * Math.PI * 2, speed: 0.16 + random() * 0.38,
  }));
  return { body, ambient };
}

export function poseBodyParticle(particle: BodyParticle, input: PoseInput): { x: number; y: number } {
  const motion = input.motionAmount ?? 1;
  const breath = Math.sin(input.elapsed * 1.15) * 0.0032 * motion;
  const shimmerX = Math.sin(input.elapsed * (0.45 + particle.drift * 0.22) + particle.phase) * 0.0017 * motion;
  const shimmerY = Math.cos(input.elapsed * (0.38 + particle.drift * 0.18) + particle.phase) * 0.0013 * motion;
  const lowerWeight = smoothstep(0.42, 0.82, particle.y);
  return { x: particle.x + shimmerX + (particle.x - 0.5) * breath * lowerWeight, y: particle.y + shimmerY + breath * (0.25 + lowerWeight * 0.75) };
}

export function particleLuminance(particle: BodyParticle, input: LuminanceInput = {}): number {
  const envelope = 0.16 + particle.edgeAlpha * 0.84;
  if (input.equalBrightness) return clamp(0.78 * envelope, 0.06, 1);
  const x = particle.x;
  const y = particle.y;
  const eyeShadow = gaussian(x, y, 0.438, 0.285, 0.055, 0.035) + gaussian(x, y, 0.562, 0.285, 0.055, 0.035);
  const noseLight = gaussian(x, y, 0.5, 0.34, 0.04, 0.095);
  const cheekLight = gaussian(x, y, 0.5, 0.395, 0.15, 0.085);
  const mouthShade = gaussian(x, y, 0.5, 0.43, 0.085, 0.035);
  const speech = clamp(input.speechEnergy ?? 0, 0, 1);
  const speechGlow = gaussian(x, y, 0.5, 0.43, 0.12, 0.065) * speech * (0.2 + Math.sin((input.elapsed ?? 0) * 8) * 0.06);
  const featureLight = 1 - eyeShadow * 0.38 - mouthShade * 0.22 + noseLight * 0.2 + cheekLight * 0.08 + speechGlow;
  return clamp(particle.brightness * envelope * featureLight, 0.035, 1);
}

function gaussian(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return Math.exp(-(dx * dx + dy * dy) * 0.5);
}
function softInside(value: number, inner: number, outer: number) { return 1 - smoothstep(inner, outer, value); }
function smoothstep(edge0: number, edge1: number, value: number) { const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1); return amount * amount * (3 - 2 * amount); }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }

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
