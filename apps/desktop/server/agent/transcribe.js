'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { httpError } = require('../http-utils');

// Resolve a command to an executable path: a path-bearing value is checked
// directly; a bare name (e.g. "whisper-cli") is looked up on PATH so the
// availability check works for PATH-installed binaries, not just absolute paths.
function resolveOnPath(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  if (cmd.includes('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* not here */
    }
  }
  return null;
}

function voiceStatus(cfg) {
  const whisper = cfg.whisper || {};
  const binary = whisper.binary;
  const model = whisper.model;
  const ffmpeg = whisper.ffmpeg || 'ffmpeg';
  const binaryOk = Boolean(resolveOnPath(binary));
  const modelOk = Boolean(model && fs.existsSync(model));
  const ffmpegOk = Boolean(resolveOnPath(ffmpeg));
  return {
    available: binaryOk && modelOk && ffmpegOk,
    binaryConfigured: Boolean(binary),
    modelConfigured: Boolean(model),
    ffmpegAvailable: ffmpegOk,
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

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // stdout is ignored so a chatty child can't deadlock on a full OS pipe:
    // whisper-cli prints the transcription to stdout, but we read the -otxt
    // file, not stdout. stderr stays piped for error reporting.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(httpError(500, stderr.trim() || `${command} exited ${code}`));
      resolve();
    });
  });
}

async function transcribe(req, cfg) {
  const status = voiceStatus(cfg);
  if (!status.available) {
    return { available: false, text: '', reason: 'whisper.cpp binary/model/ffmpeg is not configured or missing' };
  }
  const audio = await readRequestBuffer(req);
  if (!audio.length) throw httpError(400, 'audio body required');

  const whisper = cfg.whisper;
  const timeoutMs = whisper.timeoutMs || 60_000;
  const ffmpeg = whisper.ffmpeg || 'ffmpeg';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-voice-'));
  const audioPath = path.join(dir, 'audio.webm');
  const wavPath = path.join(dir, 'audio.wav');
  const outBase = path.join(dir, 'out');
  try {
    fs.writeFileSync(audioPath, audio);

    // whisper.cpp needs 16 kHz mono PCM WAV; the mic posts webm/opus.
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wavPath], timeoutMs);

    // -otxt -of <base> writes <base>.txt with the plain transcription (no timestamps).
    const args = [...(whisper.args || []), '-m', whisper.model, '-f', wavPath, '-otxt', '-of', outBase];
    await run(whisper.binary, args, timeoutMs);

    const outFile = `${outBase}.txt`;
    if (!fs.existsSync(outFile)) throw httpError(500, 'transcription produced no output');
    const text = fs.readFileSync(outFile, 'utf8').trim();
    return { available: true, text };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { voiceStatus, transcribe, resolveOnPath };
