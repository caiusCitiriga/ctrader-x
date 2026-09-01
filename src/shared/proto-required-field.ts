import type { BinaryWriter } from '@bufbuild/protobuf/wire';

const VARINT_WIRE_TYPE = 0;

/**
 * ts-proto's codegen treats proto2 `required` fields exactly like optional ones, so it omits
 * any field whose value equals the field's implicit default — the first declared member for an
 * enum with no `[default = ...]` annotation, or 0 for a numeric. cTrader's server then rejects
 * the message for missing a field the caller did set. Confirmed not fixable via codegen flags:
 * `disableProto2DefaultValues` only affects fields carrying an *explicit* default.
 *
 * Appending the field after the normal encode is a safe, minimal fix — field order carries no
 * meaning on the wire — and avoids hand-editing generated code that gets overwritten on every
 * `npm run generate:types`.
 */
export function appendRequiredEnumIfDropped(writer: BinaryWriter, fieldNumber: number, value: number, implicitDefault: number): void {
    if (value === implicitDefault) {
        writer.uint32(tagFor(fieldNumber)).int32(value);
    }
}

/** The int64 counterpart of {@link appendRequiredEnumIfDropped}; numeric fields default to 0. */
export function appendRequiredInt64IfDropped(writer: BinaryWriter, fieldNumber: number, value: number | undefined): void {
    if (value === 0) {
        writer.uint32(tagFor(fieldNumber)).int64(value);
    }
}

function tagFor(fieldNumber: number): number {
    return (fieldNumber << 3) | VARINT_WIRE_TYPE;
}
