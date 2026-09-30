import type { AdapterFactory, AdapterIdentity, TextAdapterFactory, ExecutionContext } from '@kipster/core/adapter'

// These are fixture-only operations, not the production execution/host API.
interface FixtureHost {
  record(value: string): void
}

interface FixtureAdapter extends AdapterIdentity {
  record(): void
}

export const createFixtureAdapter: AdapterFactory<FixtureHost, FixtureAdapter> = (host) => ({
  id: 'packaging-fixture',
  version: '0.0.0',
  record() {
    host.record('fixture used the supplied host')
  },
})

export const createTextFixture: TextAdapterFactory = (host) => ({
  id: 'packed-text-fixture', version: '1', contractMajor: 1,
  async execute(context) {
    await host.invokeTool({ attemptId: context.attemptId, callId: 'packed-call', name: 'echo', arguments: { text: context.input[0]?.text ?? '' } })
    return {
      events: { async *[Symbol.asyncIterator]() {
        yield { kind: 'text' as const, attemptId: context.attemptId, messageId: 'answer', text: 'packed', final: true }
        yield { kind: 'ended' as const, attemptId: context.attemptId, confirmed: true as const }
      } },
      async cancel() { return { acknowledged: true, confirmedEnded: true } },
      async reconcile() { return 'ended' as const },
    }
  },
  async close() {},
})

// Pre-maintenance consumers can still index the original text context directly.
export function firstInput(context: ExecutionContext): ExecutionContext['input'][number] | undefined {
  return context.input[0]
}
