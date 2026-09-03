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

test('particle field is deterministic and speech moves the mouth cluster', async () => {
  const { createParticleField, poseBodyParticle } = await fieldModule;
  const first = createParticleField({ bodyCount: 900, ambientCount: 64, seed: 42 });
  const second = createParticleField({ bodyCount: 900, ambientCount: 64, seed: 42 });

  assert.equal(first.body.length, 900);
  assert.equal(first.ambient.length, 64);
  assert.deepEqual(first, second);
  assert.ok(new Set(first.body.map((particle) => particle.bone)).size >= 12);

  const mouth = first.body.find((particle) => particle.bone === 'mouth');
  assert.ok(mouth);
  const quiet = poseBodyParticle(mouth, { elapsed: 1, speechEnergy: 0 });
  const speaking = poseBodyParticle(mouth, { elapsed: 1, speechEnergy: 1 });
  assert.ok(Math.abs(speaking.y - quiet.y) > 0.001);
});
