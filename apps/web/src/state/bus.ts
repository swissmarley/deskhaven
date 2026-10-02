import type { AgentEvent, Behavior } from '@agenthotel/shared';

export interface WorldSignal {
  event: AgentEvent;
  behavior: Behavior;
  behaviorChanged: boolean;
}

type Listener = (signal: WorldSignal) => void;

/** Tiny emitter so the Pixi world can react to events without re-rendering React. */
class EventBus {
  private readonly listeners = new Set<Listener>();
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(s: WorldSignal): void {
    for (const l of this.listeners) l(s);
  }
}

export const worldBus = new EventBus();
