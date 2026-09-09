'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const modelModule = import('../chat-src/avatar/model.ts');
const fieldModule = import('../chat-src/avatar/particle-field.ts');

test('avatar blends states and interruption returns promptly to listening', async () => {
  const { createAvatarModel, setAvatarState, stepAvatarModel } = await modelModule;
  const model = createAvatarModel('listening');

  setAvatarState(model, 'thinking');
  stepAvatarModel(model, 0.1);
  assert.ok(model.transition > 0 && model.transition < 1);

  for (let frame = 0; frame < 60; frame += 1) stepAvatarModel(model, 1 / 60);
  assert.equal(model.state, 'thinking');

  setAvatarState(model, 'speaking');
  for (let frame = 0; frame < 30; frame += 1) stepAvatarModel(model, 1 / 60);
  setAvatarState(model, 'interrupted');
  for (let frame = 0; frame < 24; frame += 1) stepAvatarModel(model, 1 / 60);
  assert.equal(model.targetState, 'listening');
  for (let frame = 0; frame < 30; frame += 1) stepAvatarModel(model, 1 / 60);
  assert.equal(model.state, 'listening');
});

test('speech energy is clamped and smoothed', async () => {
  const { createAvatarModel, setSpeechEnergy, stepAvatarModel } = await modelModule;
  const model = createAvatarModel('speaking');

  setSpeechEnergy(model, 4);
  stepAvatarModel(model, 1 / 30);
  assert.equal(model.speechEnergyTarget, 1);
  assert.ok(model.speechEnergy > 0 && model.speechEnergy < 1);

  setSpeechEnergy(model, Number.NaN);
  assert.equal(model.speechEnergyTarget, 0);
});

test('interrupt keeps speech energy latch and speaking resets gesture schedule', async () => {
  const { createAvatarModel, setAvatarState, setSpeechEnergy, stepAvatarModel } = await modelModule;
  const model = createAvatarModel('speaking');

  setSpeechEnergy(model, 0.42);
  model.nextGestureAt = 8.4;
  setAvatarState(model, 'interrupted');
  assert.equal(model.speechEnergyTarget, 0.42);
  assert.equal(model.speechEnergy, 0);

  for (let frame = 0; frame < 30; frame += 1) stepAvatarModel(model, 1 / 60);
  assert.equal(model.targetState, 'listening');

  setAvatarState(model, 'speaking');
  assert.equal(model.speechEnergyTarget, 0.42);
  assert.equal(model.nextGestureAt, 2.8);
  assert.ok(model.stateElapsed < model.nextGestureAt);
});

test('hidden avatars do not advance and every gesture stays restrained', async () => {
  const { createAvatarModel, gesturePose, stepAvatarModel } = await modelModule;
  const model = createAvatarModel('hidden');
  stepAvatarModel(model, 1);
  assert.equal(model.elapsed, 0);

  for (const gesture of ['outward', 'explain', 'emphasis', 'thoughtful']) {
    const values = Object.values(gesturePose(gesture, 0.5));
    assert.ok(values.every(Number.isFinite));
    assert.ok(Math.max(...values.map(Math.abs)) <= 1);
  }
});

test('each gesture produces a nonzero broad-pose signal at mid-gesture', async () => {
  const { gesturePose } = await modelModule;
  for (const gesture of ['outward', 'explain', 'emphasis', 'thoughtful']) {
    const pose = gesturePose(gesture, 0.5);
    assert.ok(Object.values(pose).some((value) => Math.abs(value) > 0.01), `${gesture} must affect the cloud pose`);
  }
});

test('particle placement is deterministic and independent of speech or facial luminance', async () => {
  const { createParticleField, particleLuminance, poseBodyParticle } = await fieldModule;
  const first = createParticleField({ bodyCount: 900, ambientCount: 64, seed: 42 });
  const second = createParticleField({ bodyCount: 900, ambientCount: 64, seed: 42 });

  assert.equal(first.body.length, 900);
  assert.equal(first.ambient.length, 64);
  assert.deepEqual(first, second);
  assert.equal(first.body.some((particle) => Object.hasOwn(particle, 'bone')), false);

  const particle = first.body.find((point) => Math.abs(point.x - 0.5) < 0.08 && Math.abs(point.y - 0.43) < 0.05);
  assert.ok(particle);
  const quiet = poseBodyParticle(particle, { elapsed: 1, motionAmount: 1 });
  const speaking = poseBodyParticle(particle, { elapsed: 1, motionAmount: 1, speechEnergy: 1 });
  assert.deepEqual(speaking, quiet);
  assert.notEqual(particleLuminance(particle, { elapsed: 1, speechEnergy: 0 }), particleLuminance(particle, { elapsed: 1, speechEnergy: 1 }));
  assert.equal(particle.size, second.body[first.body.indexOf(particle)].size);
});

test('matched interior facial windows have comparable spatial density', async () => {
  const { createParticleField } = await fieldModule;
  const field = createParticleField({ bodyCount: 4200, ambientCount: 0, seed: 77 });
  const count = (cx, cy) => field.body.filter((point) => Math.abs(point.x - cx) <= 0.035 && Math.abs(point.y - cy) <= 0.025).length;
  const windows = [count(0.44, 0.285), count(0.56, 0.285), count(0.5, 0.35), count(0.5, 0.43), count(0.42, 0.37), count(0.58, 0.37)];
  const minimum = Math.min(...windows);
  const maximum = Math.max(...windows);
  assert.ok(minimum > 8, `facial density sample too small: ${windows.join(',')}`);
  assert.ok(maximum / minimum < 1.9, `facial clustering detected: ${windows.join(',')}`);
});
