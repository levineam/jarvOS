'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { httpError } = require('../http-utils');

function voiceStatus(cfg) {
  const whisper = cfg.whisper || {};
  const binary = whisper.binary;
  const model = whisper.model;
  return {
    available: Boolean(binary && model && fs.existsSync(binary) && fs.existsSync(model)),
    binaryConfigured: Boolean(binary),
    modelConfigured: Boolean(model),
  };
}

function readRequestBuffer(req, { limit = 25 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, 'audio upload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function transcribe(req, cfg) {
  const status = voiceStatus(cfg);
  if (!status.available) {
    return { available: false, text: '', reason: 'whisper.cpp binary/model is not configured or missing' };
  }
  const audio = await readRequestBuffer(req);
  if (!audio.length) throw httpError(400, 'audio body required');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-voice-'));
  const audioPath = path.join(dir, 'audio.webm');
  fs.writeFileSync(audioPath, audio);

  const whisper = cfg.whisper;
  const args = [...(whisper.args || []), '-m', whisper.model, '-f', audioPath, '-otxt'];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(whisper.binary, args, { timeout: whisper.timeoutMs || 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(httpError(500, stderr || `whisper exited ${code}`));
      resolve(stdout);
    });
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { available: true, text: output.trim() };
}

module.exports = { voiceStatus, transcribe };
