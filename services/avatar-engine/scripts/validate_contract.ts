/**
 * Validates engine responses captured by scripts/smoke.py against the REAL zod schemas of the
 * contract (packages/shared/src/avatar-engine.ts). Run with tsx from the repo root:
 *   node_modules/.bin/tsx services/avatar-engine/scripts/validate_contract.ts capture.json
 */
import { readFileSync } from 'node:fs';
import {
  EngineAnimateRequestSchema,
  EngineHealthSchema,
  EngineJobSchema,
  EnginePrepareRequestSchema,
} from '../../../packages/shared/src/avatar-engine';

const capture = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  health: unknown[];
  jobs: unknown[];
  prepareRequests: unknown[];
  animateRequests: unknown[];
  errors: { error: { code: string; message: string } }[];
};

let checked = 0;
const failures: string[] = [];
function check(
  name: string,
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
  values: unknown[],
) {
  values.forEach((value, i) => {
    const res = schema.safeParse(value);
    checked += 1;
    if (!res.success) failures.push(`${name}[${i}]: ${JSON.stringify(res.error)}`);
  });
}
check('EngineHealth', EngineHealthSchema, capture.health);
check('EngineJob', EngineJobSchema, capture.jobs);
check('EnginePrepareRequest', EnginePrepareRequestSchema, capture.prepareRequests);
check('EngineAnimateRequest', EngineAnimateRequestSchema, capture.animateRequests);
for (const [i, e] of capture.errors.entries()) {
  checked += 1;
  if (typeof e?.error?.code !== 'string' || typeof e?.error?.message !== 'string') {
    failures.push(`error[${i}]: not { error: { code, message } }`);
  }
}
const kinds = new Set(
  (capture.jobs as { result: { kind: string } | null }[])
    .map((j) => j.result?.kind)
    .filter(Boolean),
);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `zod contract validation OK: ${checked} objects (result kinds: ${[...kinds].join(', ')})`,
);
