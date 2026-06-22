'use strict';

const skillContractSchema = require('./schemas/skill-contract.schema.json');
const journalEntry = require('./contracts/journal-entry');
const noteCreation = require('./contracts/note-creation');
const ideaParking = require('./contracts/idea-parking');
const memoryPromotion = require('./contracts/memory-promotion');
const workIntake = require('./contracts/work-intake');

const contracts = [
  journalEntry,
  noteCreation,
  ideaParking,
  memoryPromotion,
  workIntake,
];

function listSkillContracts() {
  return contracts.slice();
}

function getSkillContract(name) {
  return contracts.find((contract) => contract.name === name) || null;
}

module.exports = {
  skillContractSchema,
  contracts,
  listSkillContracts,
  getSkillContract,
  journalEntry,
  noteCreation,
  ideaParking,
  memoryPromotion,
  workIntake,
};
