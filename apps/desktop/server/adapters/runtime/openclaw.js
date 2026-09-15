'use strict';

const paperclip = require('../paperclip');

async function dispatch(cfg, { title, task, plan }) {
  const description = [
    'Dispatched from jarvOS Desktop Chat.',
    '',
    '## Task',
    task,
    plan ? ['', '## Plan', plan].join('\n') : '',
    '',
    'This issue should run under the normal clawd/Paperclip gates.',
  ].filter(Boolean).join('\n');

  const issue = await paperclip.createIssue(cfg, {
    title,
    description,
    priority: 'medium',
    status: 'todo',
    projectId: cfg.projectId,
  });
  return {
    dispatched: true,
    runtime: 'openclaw',
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
  };
}

module.exports = { dispatch };
