'use strict';
function createSchedulerAdapter({ platform = process.platform, launchd, systemd } = {}) {
  const delegate = platform === 'darwin' ? launchd : platform === 'linux' ? systemd : null;
  return { register(job) { return delegate?.register ? delegate.register(job) : { status: 'scheduler_unsupported' }; }, remove(id) { return delegate?.remove ? delegate.remove(id) : { status: 'scheduler_unsupported' }; } };
}
module.exports = { createSchedulerAdapter };
