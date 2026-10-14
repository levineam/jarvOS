'use strict';

const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '../../jarvos-runtime-kit');
const destination = path.resolve(__dirname, '../node_modules/@jarvos/runtime-kit');

const sourceStat = fs.lstatSync(source);
if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
  throw new Error('runtime-kit source must be a real directory');
}

if (fs.existsSync(destination)) {
  const destinationStat = fs.lstatSync(destination);
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
    throw new Error('runtime-kit bundle destination must be a real directory');
  }
  fs.rmSync(destination, { recursive: true, force: true });
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true, force: true });
