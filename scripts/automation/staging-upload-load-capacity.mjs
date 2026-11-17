const transfer = 'LKC_SUBMISSION_TRANSFER_MODE';
const original = Object.freeze({memory: '256Mi', concurrency: 80, gib: .25});
const capacity = Object.freeze({
  createUploadSession: Object.freeze({memory: '512Mi', concurrency: 16, gib: .5}),
  finalizeStagedUpload: Object.freeze({memory: '1Gi', concurrency: 8, gib: 1}),
});
const expect = (value, code) => { if (!value) throw Error(code); };

export function loadCapacity(name, mode) {
  expect(Object.hasOwn(capacity, name) && ['paused', 'acceptance'].includes(mode),
    'UPLOAD_ACCEPTANCE_LOAD_CAPACITY_SCOPE');
  return mode === 'acceptance' ? capacity[name] : original;
}

export function normalizeLoadCapacity(image, name, mode) {
  const expected = loadCapacity(name, mode);
  const config = image.fn.serviceConfig, template = image.service.spec.template.spec;
  const limits = template.containers[0].resources?.limits;
  expect(config.availableMemory === expected.memory && config.maxInstanceRequestConcurrency === expected.concurrency
    && template.containerConcurrency === expected.concurrency && limits?.memory === expected.memory
    && ['1', '1000m'].includes(limits?.cpu) && String(config.availableCpu) === '1'
    && config.maxInstanceCount === 20 && (config.minInstanceCount ?? 0) === 0 && config.timeoutSeconds === 60,
  'UPLOAD_ACCEPTANCE_LOAD_CAPACITY_MISMATCH');
  config.availableMemory = original.memory;
  config.maxInstanceRequestConcurrency = original.concurrency;
  template.containerConcurrency = original.concurrency;
  limits.memory = original.memory;
  return image;
}

export function loadCapacityPatch(before, name, next) {
  const config = before.fn.serviceConfig;
  const target = loadCapacity(name, next);
  const mode = config.environmentVariables[transfer];
  const current = loadCapacity(name, mode);
  if (next === 'acceptance') {
    expect(mode === 'paused' && config.availableMemory === current.memory
      && config.maxInstanceRequestConcurrency === current.concurrency, 'UPLOAD_ACCEPTANCE_LOAD_CAPACITY_MISMATCH');
  } else if (![original.memory, capacity[name].memory].includes(config.availableMemory)
    || ![original.concurrency, capacity[name].concurrency].includes(config.maxInstanceRequestConcurrency)) {
    // Stop intake even if a provider returns an unexpected capacity setting.
    // A recovery write never replaces capacity outside the approved profiles.
    return {additions: {}, mask: ''};
  }
  return {
    additions: {availableMemory: target.memory, maxInstanceRequestConcurrency: target.concurrency},
    mask: ',serviceConfig.availableMemory,serviceConfig.maxInstanceRequestConcurrency',
  };
}
