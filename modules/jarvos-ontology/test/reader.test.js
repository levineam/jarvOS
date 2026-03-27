import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import {
  loadOntology,
  getGoals,
  getBeliefs,
  getProjects,
  getPredictions,
  getLinks,
  getById,
  findOrphans,
} from '../src/reader.js';

const ONTOLOGY_DIR = resolve(new URL('.', import.meta.url).pathname, '..', 'ontology');

describe('reader', () => {
  it('loads ontology from canonical files', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    assert.ok(ontology.objects.length > 0, 'should have objects');
    assert.ok(ontology.links.length > 0, 'should have links');
    assert.equal(ontology.missingFiles.length, 0, 'no missing files');
  });

  it('parses higher order', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    const ho = getById(ontology, 'HO');
    assert.ok(ho, 'should find higher order');
    assert.equal(ho.type, 'higher-order');
    assert.ok(ho.statement?.length > 10, 'should have statement text');
  });

  it('parses beliefs with IDs', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    const beliefs = getBeliefs(ontology);
    assert.ok(beliefs.length >= 4, `should have at least 4 beliefs, got ${beliefs.length}`);

    const b1 = getById(ontology, 'B1');
    assert.ok(b1, 'should find B1');
    assert.equal(b1.type, 'belief');
    assert.ok(b1.name.includes('nested swarms'), 'B1 name should mention nested swarms');
    assert.ok(b1.metadata.status, 'B1 should have status');
    assert.ok(b1.links.length > 0, 'B1 should have links');
  });

  it('parses goals with links', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    const goals = getGoals(ontology);
    assert.ok(goals.length >= 3, `should have at least 3 goals, got ${goals.length}`);

    const g1 = getById(ontology, 'G1');
    assert.ok(g1, 'should find G1');
    assert.ok(g1.links.some(l => l.type === 'serves'), 'G1 should serve something');
  });

  it('parses projects', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    const projects = getProjects(ontology);
    assert.ok(projects.length >= 8, `should have at least 8 projects, got ${projects.length}`);

    const pj1 = getById(ontology, 'PJ1');
    assert.ok(pj1, 'should find PJ1');
    assert.equal(pj1.type, 'project');
    assert.ok(pj1.name.includes('Swarm Theory'));
  });

  it('parses core self', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    const core = getById(ontology, 'CORE');
    assert.ok(core, 'should find CORE');
    assert.ok(core.mission?.length > 5, 'should have mission');
  });

  it('extracts links across objects', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    const links = getLinks(ontology);
    assert.ok(links.length > 10, `should have many links, got ${links.length}`);

    // Verify link structure
    const servesLinks = links.filter(l => l.type === 'serves');
    assert.ok(servesLinks.length > 0, 'should have serves links');
  });

  it('finds orphans if any', () => {
    const ontology = loadOntology(ONTOLOGY_DIR);
    const orphans = findOrphans(ontology);
    // Orphans are possible — just verify the function works
    assert.ok(Array.isArray(orphans), 'should return array');
  });
});
