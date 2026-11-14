import { AppError, api, newId } from '@parlante/shared';
import { describeCapabilities } from '@parlante/providers';
import { defineRoute } from '../../lib/define-route';
import { defineModule } from '../../lib/modules';

/**
 * EXAMPLE MODULE (real, autoloaded). Shows the minimal shape of a module:
 *   - one file `modules/<name>/index.ts` default-exporting `defineModule({ name, register })`
 *   - routes declared in the shared contract (`api.<group>.<route>`) and implemented with
 *     `defineRoute` — validation, auth, roles, OpenAPI and serialisation come from the contract
 *   - dependencies taken from the app: `app.db`, `app.queues`, `app.providers`, `app.fileUrl`
 * For a database-backed CRUD module (workspace scoping, pagination, roles) copy
 * `modules/_template`.
 */
export default defineModule({
  name: 'system',
  register(app) {
    defineRoute(app, api.system.capabilities, async ({ app: instance }) =>
      describeCapabilities(instance.providers),
    );

    // API → queue → worker round trip: enqueue a `system` job…
    defineRoute(app, api.system.pingWorker, async ({ body, app: instance }) => {
      const { jobId } = await instance.queues.enqueue(
        'system',
        { kind: 'ping', echo: body.echo },
        { jobId: `ping_${newId('event').slice(4)}` },
      );
      return { jobId, state: 'waiting' as const, result: null };
    });

    // …and read its state / result back.
    defineRoute(app, api.system.workerPingStatus, async ({ params, app: instance }) => {
      const job = await instance.queues.getJob('system', params.jobId);
      if (!job) throw AppError.notFound('Ping job');
      return { jobId: job.id, state: job.state, result: job.result };
    });
  },
});
