import { executionProfileSubject } from './execution-profile-routing.js';

export function createEnvironmentMaterializationPolicy() {
  return Object.freeze({
    subject: Object.freeze({
      async resolve({ profile }) {
        return executionProfileSubject(profile);
      },
    }),
    settings: Object.freeze({
      async resolve({ resources, boot }) {
        if (!resources || !Number.isSafeInteger(resources.memoryBytes) || !Number.isSafeInteger(resources.processorCount)) throw new TypeError('environment materialization resources are invalid');
        if (boot?.requirement !== 'efi-v1') throw new Error(`unsupported environment boot requirement: ${String(boot?.requirement ?? 'missing')}`);
        return Object.freeze({ memoryBytes: resources.memoryBytes, processorCount: resources.processorCount, firmware: 'efi' });
      },
    }),
  });
}
