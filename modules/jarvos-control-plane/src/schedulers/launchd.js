'use strict';
function createLaunchdScheduler({ register } = {}) { return { register(job) { return register ? register(job) : { status: 'scheduler_unsupported' }; }, remove() { return { status: 'removed' }; } }; }
module.exports = { createLaunchdScheduler };
