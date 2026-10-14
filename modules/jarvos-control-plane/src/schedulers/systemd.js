'use strict';
function createSystemdScheduler({ register } = {}) { return { register(job) { return register ? register(job) : { status: 'scheduler_unsupported' }; }, remove() { return { status: 'removed' }; } }; }
module.exports = { createSystemdScheduler };
