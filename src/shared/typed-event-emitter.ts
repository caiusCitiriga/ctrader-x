import { EventEmitter } from 'node:events';

export type EventMap = Record<string, unknown[]>;

/**
 * Wraps Node's EventEmitter instead of extending it, so `emit` stays protected:
 * consumers can only listen, only the owning class can trigger events.
 */
export class TypedEventEmitter<TEvents extends EventMap> {
    private readonly emitter = new EventEmitter();

    on<TEvent extends keyof TEvents & string>(
        event: TEvent,
        listener: (...args: TEvents[TEvent]) => void,
    ): this {
        this.emitter.on(event, listener as (...args: unknown[]) => void);
        return this;
    }

    once<TEvent extends keyof TEvents & string>(
        event: TEvent,
        listener: (...args: TEvents[TEvent]) => void,
    ): this {
        this.emitter.once(event, listener as (...args: unknown[]) => void);
        return this;
    }

    off<TEvent extends keyof TEvents & string>(
        event: TEvent,
        listener: (...args: TEvents[TEvent]) => void,
    ): this {
        this.emitter.off(event, listener as (...args: unknown[]) => void);
        return this;
    }

    protected emit<TEvent extends keyof TEvents & string>(
        event: TEvent,
        ...args: TEvents[TEvent]
    ): boolean {
        return this.emitter.emit(event, ...args);
    }
}
